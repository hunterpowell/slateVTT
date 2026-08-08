//! The room actor.
//!
//! One `tokio` task exclusively owns `RoomState`. Nothing else can reach it, so
//! there are no locks on it and no `Arc<Mutex<_>>`. Commands arrive on one
//! `mpsc`; each client gets its own `mpsc` back — never a `broadcast`, because
//! `broadcast` hands every subscriber the same value and fog of war will need
//! different clients to receive different messages for one event.

use std::collections::HashMap;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until};
use tracing::{debug, error, warn};
use uuid::Uuid;

use crate::protocol::{
    Calibration, ClientId, ClientMsg, Hp, Initiative, InitiativeEntry, MapInfo, Origin, Owner,
    PlayerId, Pos, RoomView, RosterEntry, RosterSlot, ServerMsg, Shape, ShapeId, ShapeKind, Token,
    TokenId, TokenView, Wall, WallId, WallKind,
};
use crate::store::{Saved, Store};

/// Per-client outbound buffer. Six clients at ~30 Hz never approach this; if a
/// client does fill it, its socket is wedged and it gets dropped.
pub const CLIENT_MAILBOX: usize = 256;
const ROOM_MAILBOX: usize = 128;

/// How long a change may sit unsaved. Long enough that a DM placing six
/// monsters writes the file once instead of six times; short enough that a
/// power cut costs a move, not an evening.
const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);

/// Bounds on a calibrated grid. The floor is not fussiness: the client draws one
/// overlay line per cell, so a two-pixel grid on a large map is hundreds of
/// thousands of lines per frame and a locked-up browser.
const MIN_GRID_PX: f32 = 4.0;
const MAX_GRID_PX: f32 = 4096.0;
/// Comfortably longer than anything the upload endpoint generates, short enough
/// that nobody can grow the save file through this field.
const MAX_URL_LEN: usize = 512;
/// Larger than any real map image, and small enough that the client cannot be
/// asked to rule an unbounded number of grid lines.
const MAX_MAP_PX: f32 = 32768.0;

/// Long enough for "Goblin Archer (bloodied)", short enough that the label
/// drawn under the token stays a label.
const MAX_TOKEN_NAME_LEN: usize = 48;
/// The sizes a token may be, in grid cells. A closed set rather than a range
/// because the snapping rule is defined per size, and because a dropdown of five
/// entries is a better answer to "how big is it" than a number field.
///
/// The half is for a druid who is currently a rat. It snaps like a single-cell
/// token and is simply drawn smaller — see `snap_to_cell`.
const TOKEN_SIZES: [f32; 5] = [0.5, 1.0, 2.0, 3.0, 4.0];
/// Bounds the save file, and is far past a battle anyone runs. A DM who hits
/// this has a room that wants clearing out rather than one more goblin.
const MAX_TOKENS: usize = 200;
/// How far a hit point total may run in either direction. Negative is allowed
/// because a DM tracking how far past nothing something went is bookkeeping, not
/// a rule — this only stops the save file growing through a number field.
const MAX_HP: i32 = 9999;

/// Bounds the save file the way `MAX_TOKENS` does. Well past what a fight puts
/// on the board, and low enough that a board nobody has cleared in a month is
/// still a board the client can draw.
const MAX_SHAPES: usize = 64;
/// How far a shape may reach from its origin, in cells — 150 feet.
///
/// Not fussiness either, and the same failure as `MIN_GRID_PX`: an area shape
/// tints every cell it covers, so the client walks the cells inside its bounding
/// box. A circle a million cells across is a frozen browser on five other
/// machines, and a sketch reaches them before anybody has decided to keep it.
const MAX_SHAPE_CELLS: f32 = 30.0;

/// How many segments a map may hold. A traced dungeon is a couple of hundred, so
/// this is generous rather than tight — it is here to bound the save file and
/// the shadowcast fog will run against these, not to tell a DM when to stop.
const MAX_WALLS: usize = 2000;
/// Corners in one traced run. A DM who reaches this has been clicking for a
/// while without finishing; the run is an authoring convenience and splitting a
/// long one in two costs nothing.
const MAX_WALL_POINTS: usize = 256;

/// Five players plus the DM, per the brief. The DM holds no slot.
const ROSTER: [(&str, &str); 5] = [
    ("grog", "Grog"),
    ("vex", "Vex"),
    ("pike", "Pike"),
    ("nyx", "Nyx"),
    ("bram", "Bram"),
];

pub enum RoomCmd {
    /// Socket opened. No identity yet, so this client is told nothing.
    Connected {
        client: ClientId,
        out: mpsc::Sender<ServerMsg>,
    },
    Disconnected {
        client: ClientId,
    },
    Msg {
        client: ClientId,
        msg: ClientMsg,
    },
    /// Stop accepting commands, flush any pending save, then acknowledge that
    /// the room is safely on disk. Used by the process shutdown path.
    Shutdown {
        done: oneshot::Sender<bool>,
    },
}

#[derive(Clone)]
pub struct RoomHandle {
    tx: mpsc::Sender<RoomCmd>,
}

impl RoomHandle {
    /// `false` once the room task is gone, which only happens at shutdown.
    pub async fn send(&self, cmd: RoomCmd) -> bool {
        self.tx.send(cmd).await.is_ok()
    }

    /// Completes after the room has attempted to flush its last dirty state,
    /// returning whether that state is safely on disk.
    pub async fn shutdown(&self) -> bool {
        let (done, flushed) = oneshot::channel();
        if self.tx.send(RoomCmd::Shutdown { done }).await.is_ok() {
            return flushed.await.unwrap_or(false);
        }
        false
    }
}

/// Internal, and deliberately not `ServerMsg`. They are 1:1 today; keeping them
/// apart is what lets one event become a different message per recipient.
#[derive(Debug, Clone)]
enum Event {
    TokenMoved {
        id: TokenId,
        x: f32,
        y: f32,
        dragging: bool,
        /// The token's plan for the staged map rather than its position. Reaches
        /// the DM alone, because that is a field only they hold.
        staged: bool,
    },
    /// A token was created or edited. Carries only the id, so `message_for`
    /// reads the token off `&self` per recipient — the seam where a hidden
    /// token becomes a `TokenRemoved` for the players and a `TokenChanged` for
    /// the DM, from this one event.
    TokenChanged {
        id: TokenId,
        /// Whether the table could see this token *before* the change. It is
        /// the one fact `message_for` cannot read off `&self`, because `apply`
        /// has already overwritten it, and it is what separates "it just
        /// vanished" from "you were never told it was there".
        ///
        /// "Unseen" and not "hidden": a token built on the next map is equally
        /// absent from the table's board and has to travel the same three arms.
        /// See `Token::unseen`.
        ///
        /// A token that has just been created counts as unseen: nobody holds it
        /// yet, so a create that lands out of sight is nothing to announce.
        was_unseen: bool,
    },
    TokenRemoved {
        id: TokenId,
        /// Same reason, and the same fact: `apply` has already taken the token
        /// out of the room, so whether the table knew it existed cannot be
        /// looked up any more. A player who was never told it was there is not
        /// told it is gone — that frame would name an id they should not hold.
        was_unseen: bool,
    },
    /// Only the half of a token that the DM alone holds changed: its plan for
    /// the staged map, and nothing the table could observe either way.
    ///
    /// Filtered by *who the recipient is*, like `StagedChanged`, rather than by
    /// anything anyone did. That is the whole point of it existing rather than
    /// reusing `TokenChanged`: a player's copy of this token is byte-identical
    /// before and after, so a frame for them would carry no data and still
    /// announce, to anyone with devtools open, the moment the DM threw a plan
    /// away. Invariant 4 is about what a client may know, and *that something
    /// happened* is something to know.
    TokenPlanChanged { id: TokenId },
    /// A promote applied this token's plan: it came into existence on the board,
    /// or it moved, or both.
    ///
    /// Its own variant because it is the one event that leaves in three genuinely
    /// different shapes at once — a full token for the DM, whose staged fields
    /// have just been emptied and who cannot learn that from a `TokenMoved`; a
    /// creation for a player meeting it for the first time; and a plain move for
    /// a player who has been watching it all along.
    Promoted {
        id: TokenId,
        /// As above — read before `apply` cleared `staged_only`.
        was_unseen: bool,
        /// Its live position changed, which is to say it had a plan. False for a
        /// token that only came into existence where it already stood.
        moved: bool,
    },
    /// Carries no payload on purpose: `message_for` has `&self` and builds the
    /// panel per recipient. That seam is now load-bearing — a hidden creature's
    /// row is dropped from the copy the table receives, and fog of war will hide
    /// an unseen monster's the same way.
    InitiativeChanged,
    /// A new image, a recalibrated grid, or both. Payload-free for the same
    /// reason as above — terrain is exactly what fog of war filters first.
    MapChanged,
    /// The staged slot changed: filled, recalibrated, discarded, or emptied by a
    /// promote. The first event that survives for one recipient and not another
    /// because of *who they are* rather than what they just did.
    StagedChanged,

    /// Somebody is sweeping out a shape. Carries its payload, unlike the events
    /// above that are rebuilt per recipient, because a sketch is the same line
    /// for everyone allowed to see it — there is nothing in it to redact.
    ///
    /// Worth no disk write and no state: it is gone when the mouse comes up.
    Sketching {
        by: ClientId,
        kind: ShapeKind,
        at: Pos,
        to: Pos,
        color: String,
    },
    /// A sweep ended — released, or its client disconnected. `by` is enough to
    /// find it, because there is only ever one per connection.
    SketchEnded { by: ClientId },
    /// The drawn shapes changed. Payload-free like `InitiativeChanged`, and for
    /// the same reason twice over: the list is short, and the copy the table may
    /// hold is not the copy the DM may hold.
    ///
    /// One event for adding, deleting, clearing, and for the three things that
    /// reach in from outside — a token being deleted, a token being hidden or
    /// revealed, and a new map arriving on the board.
    ShapesChanged,
    /// The traced walls changed: a run added, a segment erased, a door swung, or
    /// the board swept by a new map.
    ///
    /// Payload-free like the two above, but for a simpler reason than either:
    /// there is only one recipient it can ever have. Filtered by *who* rather
    /// than by what anyone did, like `StagedChanged` and `TokenPlanChanged`, and
    /// it is the strongest case of that shape yet — a player is not told a wall
    /// exists, was erased, or was ever traced.
    WallsChanged,
}

impl Initiative {
    fn index_of(&self, token: &TokenId) -> Option<usize> {
        self.entries.iter().position(|e| &e.token == token)
    }

    /// Adds or re-values a token, then restores the sort. `sort_by` is stable,
    /// so equal values keep the order the DM entered them in.
    ///
    /// Deliberately does not touch `current`. The DM types values in whatever
    /// order the table calls them out, so "first entered" says nothing about
    /// who acts first — combat begins when the DM advances the turn.
    fn set(&mut self, token: TokenId, value: i32) {
        match self.index_of(&token) {
            Some(i) => {
                if let Some(entry) = self.entries.get_mut(i) {
                    entry.value = value;
                }
            }
            None => self.entries.push(InitiativeEntry { token, value }),
        }
        self.entries.sort_by(|a, b| b.value.cmp(&a.value));
    }

    fn remove(&mut self, token: &TokenId) {
        let Some(i) = self.index_of(token) else {
            return;
        };
        self.entries.remove(i);

        if self.current.as_ref() == Some(token) {
            // Whoever slid into that slot takes the turn — the natural reading
            // of a creature dropping on its own initiative.
            self.current = self
                .entries
                .get(i)
                .or_else(|| self.entries.first())
                .map(|e| e.token.clone());
        }
        if self.entries.is_empty() {
            self.current = None;
        }
    }

    fn clear(&mut self) {
        *self = Initiative::default();
    }

    /// Advances, or starts combat if nothing is acting yet.
    fn next_turn(&mut self) {
        if self.entries.is_empty() {
            return;
        }

        let Some(current) = self.current.as_ref().and_then(|t| self.index_of(t)) else {
            // Combat beginning: whoever rolled highest goes first.
            self.current = self.entries.first().map(|e| e.token.clone());
            return;
        };

        let next = current + 1;
        if next >= self.entries.len() {
            self.round += 1;
        }
        let next = next % self.entries.len();
        self.current = self.entries.get(next).map(|e| e.token.clone());
    }

    fn previous_turn(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        // Nothing to step back from before combat has started.
        let Some(current) = self.current.as_ref().and_then(|t| self.index_of(t)) else {
            return;
        };

        if current == 0 {
            // Refuse to reverse past the start of combat rather than inventing a
            // round 0.
            if self.round <= 1 {
                return;
            }
            self.round -= 1;
            self.current = self.entries.last().map(|e| e.token.clone());
            return;
        }
        self.current = self.entries.get(current - 1).map(|e| e.token.clone());
    }
}

/// Who a connection turned out to be. An enum rather than the brief's
/// `is_dm` + `player_id` pair, so "a DM with a roster slot" and "a player who
/// is also DM" are unrepresentable instead of merely unexpected.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identity {
    Dm,
    Player(PlayerId),
}

struct Client {
    out: mpsc::Sender<ServerMsg>,
    identity: Identity,
}

pub struct RoomState {
    dm_secret: String,
    roster: Vec<RosterEntry>,
    map: MapInfo,
    /// The map the DM is preparing for later, which the table cannot see. It is
    /// stripped in `snapshot_for` and filtered out in `message_for`; walls will
    /// leave by the same two doors.
    staged: Option<MapInfo>,
    tokens: HashMap<TokenId, Token>,
    initiative: Initiative,
    /// Everything drawn on the board, in draw order.
    ///
    /// A `Vec` rather than a `HashMap` keyed by id, unlike the tokens: the list
    /// is short, it is only ever looked up by id when something is deleted, and
    /// its order is the z-order — which a map would have to be sorted back into
    /// on every send. Shapes belong to the live board alone; the staged map has
    /// none, so there is nothing here that forks.
    shapes: Vec<Shape>,
    /// The walls and doors traced over the map image, in image pixels.
    ///
    /// A `Vec` for the reason the shapes are one, except that order here is not
    /// z-order and means nothing at all — it is simply the order they were
    /// traced in. They belong to the live board like the shapes do: the staged
    /// map has none, because walls staged alongside a map are the scene concept
    /// CLAUDE.md rules out.
    walls: Vec<Wall>,
    /// How each map URL was last calibrated. Server-side only — it never enters
    /// a snapshot or a message, because the finished `MapInfo` already says
    /// everything a client needs.
    calibrations: HashMap<String, Calibration>,
    /// Identified clients. Only these receive events.
    clients: HashMap<ClientId, Client>,
    /// Connected but not yet identified. They hold a sender and nothing else.
    pending: HashMap<ClientId, mpsc::Sender<ServerMsg>>,
}

pub fn spawn(dm_secret: String, saved: Option<Saved>, store: Store) -> RoomHandle {
    let state = match saved {
        Some(saved) => RoomState::restored(saved, dm_secret),
        None => RoomState::hardcoded(dm_secret),
    };

    let (tx, rx) = mpsc::channel(ROOM_MAILBOX);
    tokio::spawn(run(state, rx, store));
    RoomHandle { tx }
}

async fn run(mut state: RoomState, mut rx: mpsc::Receiver<RoomCmd>, store: Store) {
    // `Some(deadline)` is the whole of the dirty flag. It is an absolute instant
    // rather than a duration because the timer is rebuilt on every command:
    // restarting a countdown thirty times a second would let a long drag hold
    // the save off indefinitely, whereas a fixed deadline caps how stale the
    // file can get no matter how much traffic arrives.
    let mut save_at: Option<Instant> = None;

    loop {
        // `Receiver::recv` is cancel-safe, so losing the race to the timer
        // discards nothing — the command is still queued next time round.
        let cmd = match save_at {
            None => rx.recv().await,
            Some(at) => tokio::select! {
                cmd = rx.recv() => cmd,
                _ = sleep_until(at) => {
                    save_at = flush(&state, &store).await;
                    continue;
                }
            },
        };

        let Some(cmd) = cmd else { break };

        let dirty = match cmd {
            RoomCmd::Connected { client, out } => {
                state.pending.insert(client, out);
                false
            }
            RoomCmd::Disconnected { client } => {
                state.pending.remove(&client);
                if state.clients.remove(&client).is_some() {
                    debug!(?client, remaining = state.clients.len(), "client left");
                    // That slot just came free; anyone still on the picker
                    // should see it immediately.
                    state.refresh_pickers();
                    // A client that vanishes mid-sweep sends no release, and
                    // its line would sit on five other screens until somebody
                    // reloaded. Sent unconditionally, because "was that client
                    // sketching" is state the room would have to keep to answer
                    // and an id nobody is drawing is a no-op on arrival.
                    //
                    // This is what a movement ruler cannot have: nothing tells
                    // the room a drag stopped, so that one guesses with a
                    // timeout. Here the socket closing *is* the news.
                    state.dispatch(client, &[Event::SketchEnded { by: client }]);
                }
                // Who happens to be connected is not part of the room.
                false
            }
            RoomCmd::Msg { client, msg } => state.handle(client, msg),
            RoomCmd::Shutdown { done } => {
                let saved = if save_at.is_some() {
                    // A shutdown is allowed to wait for the disk. A failed save
                    // is still logged by `flush`; there is no useful retry once
                    // the process has been asked to stop.
                    flush(&state, &store).await.is_none()
                } else {
                    true
                };
                let _ = done.send(saved);
                return;
            }
        };

        if dirty {
            // `get_or_insert`, not assignment: the deadline belongs to the
            // oldest unsaved change, not the newest.
            save_at.get_or_insert_with(|| Instant::now() + SAVE_DEBOUNCE);
        }
    }

    // The room outlives every client, so reaching here means the process is on
    // its way down. Anything still inside the debounce window gets a last write.
    if save_at.is_some() {
        flush(&state, &store).await;
    }
}

/// Writes the room out and returns the next deadline: `None` once it is safely
/// on disk, or a retry if it is not. Clearing the flag on a failed write would
/// throw the change away silently, and a disk is rarely full for long.
async fn flush(state: &RoomState, store: &Store) -> Option<Instant> {
    match store.save(&state.to_saved()).await {
        Ok(()) => {
            debug!(path = %store.path().display(), "room saved");
            None
        }
        Err(err) => {
            error!(%err, path = %store.path().display(), "could not save the room; will retry");
            Some(Instant::now() + SAVE_DEBOUNCE)
        }
    }
}

/// Which events are worth a disk write. Mid-drag frames are not: they are ~30 Hz
/// of positions the token was only passing through, and the drop that follows
/// carries the one it settled on. Persisting them would rewrite the file
/// continuously for the length of every drag to record a position nobody chose.
fn persists(event: &Event) -> bool {
    match event {
        // Which slot the frame was for makes no difference: a plan is dragged
        // into place exactly like a position, and the frames it passes through
        // are worth no more than the ones a live drag passes through.
        Event::TokenMoved { dragging, .. } => !dragging,
        Event::TokenChanged { .. }
        | Event::TokenRemoved { .. }
        | Event::TokenPlanChanged { .. }
        | Event::Promoted { .. }
        | Event::InitiativeChanged
        | Event::MapChanged
        | Event::StagedChanged
        | Event::ShapesChanged
        // Half an hour of tracing. The one thing in the room where losing the
        // last two seconds of work would mean losing the segment the DM was
        // most likely to be in the middle of.
        | Event::WallsChanged => true,
        // A sketch is not in the room to be saved. It is the one thing here
        // that exists only between two pointer events, which is exactly why a
        // measuring line costs the disk nothing at all.
        Event::Sketching { .. } | Event::SketchEnded { .. } => false,
    }
}

/// `what` completes "only the DM can …", so the refusal names the thing that
/// was refused rather than making the player guess which rule they hit.
fn require_dm(client: &Client, what: &str) -> Result<(), String> {
    match client.identity {
        Identity::Dm => Ok(()),
        Identity::Player(_) => Err(format!("only the DM can {what}")),
    }
}

/// Rejects the infinities before they can reach `RoomState`.
///
/// This is about the save file, not about arithmetic. `serde_json` writes a
/// non-finite `f32` as `null`, and `null` does not deserialize back into an
/// `f32` — `#[serde(default)]` fills in *missing* fields, not null ones. One
/// such value reaching the room would therefore be written to disk and then
/// refuse to load, and the server would decline to boot until somebody edited
/// the file by hand.
///
/// The route in is narrower than it looks and easy to dismiss: `serde_json`
/// rejects a literal `NaN` as invalid JSON and `1e400` as out of range. But
/// `1e39` is a perfectly good `f64`, and narrowing it to `f32` gives infinity.
/// That one gets all the way here.
fn finite(values: &[f32]) -> Result<(), String> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err("that is not a position".to_owned())
    }
}

/// `#rrggbbaa`, and nothing else. Restricting the colour to one exact shape
/// rather than accepting CSS keeps validation total: the client always writes
/// this form, and the server never has to reason about what `hsl(...)` means or
/// hand the browser a string that turns out not to be a colour at all.
fn is_hex_rgba(s: &str) -> bool {
    s.len() == 9 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Everything a token carries besides its position and its id, checked once for
/// both the command that creates a token and the command that edits one.
///
/// `img` is held to a site-relative path. The DM is trusted, so this is not a
/// permission check — it keeps the room self-contained. A token pointing at
/// somebody else's server is art that vanishes the evening that server is down,
/// and it would be the one thing in a save the uploads directory does not back.
///
/// `hidden` needs no check at all: a bool has no bad value, and either state is
/// a legitimate thing for the DM to ask for.
fn token_fields(name: &str, img: &str, size: f32, hp: Option<Hp>) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_TOKEN_NAME_LEN {
        return Err(format!(
            "a token needs a name, of at most {MAX_TOKEN_NAME_LEN} characters"
        ));
    }
    // `//host/path` is a protocol-relative URL, which is off-site despite
    // starting with a slash.
    if !img.is_empty() && (!img.starts_with('/') || img.starts_with("//")) {
        return Err("token art has to be a file on this server".to_owned());
    }
    if img.len() > MAX_URL_LEN {
        return Err("that is not a usable image URL".to_owned());
    }
    if !TOKEN_SIZES.contains(&size) {
        return Err("that is not a size a token can be".to_owned());
    }
    // Bounded, not related: whether `current` may exceed `max` is a question
    // about what a hit point means, and that is rules knowledge. The DM writes
    // down two numbers and the room keeps them.
    if let Some(hp) = hp
        && (!(-MAX_HP..=MAX_HP).contains(&hp.current) || !(-MAX_HP..=MAX_HP).contains(&hp.max))
    {
        return Err(format!(
            "hit points must be between {} and {MAX_HP}",
            -MAX_HP
        ));
    }
    Ok(())
}

/// The geometry a sketch and a kept shape have in common, checked once for both.
///
/// The extent bound is the load-bearing half. Everything else here is the usual
/// hygiene; that one stops a single frame from walking a million cells on five
/// other people's machines, and it has to be checked on the sketch as well as on
/// the shape, because the sketch is what reaches them first.
fn shape_fields(to: Pos, color: &str) -> Result<(), String> {
    finite(&[to.x, to.y])?;
    if to.x.abs() > MAX_SHAPE_CELLS || to.y.abs() > MAX_SHAPE_CELLS {
        return Err(format!(
            "a shape can reach at most {} feet",
            MAX_SHAPE_CELLS as i32 * 5
        ));
    }
    if !is_hex_rgba(color) {
        return Err("a shape colour must look like #rrggbbaa".to_owned());
    }
    Ok(())
}

/// Who a client is, as a shape records it. The one place `Identity` becomes
/// `Owner`: they say the same thing, but `Identity` is who is connected and
/// `Owner` is what a token or a drawing remembers about them.
fn drawn_by(client: &Client) -> Owner {
    match &client.identity {
        Identity::Dm => Owner::Dm,
        Identity::Player(id) => Owner::Player(id.clone()),
    }
}

/// The permission rule for erasing. The DM may clear anything; everyone else may
/// take back what they drew.
///
/// This is the only thing in the room a player may destroy, and the only reason
/// `Shape::by` is stored. It is deliberately not `can_move`'s shape — a shape is
/// nobody's to move, and nothing but this asks who drew one.
fn can_erase(client: &Client, shape: &Shape) -> bool {
    match &client.identity {
        Identity::Dm => true,
        Identity::Player(id) => matches!(&shape.by, Owner::Player(by) if by == id),
    }
}

/// The permission rule for movement. Creating, deleting and editing a token —
/// including reassigning its `owner` — are DM-only and checked in `check`.
fn can_move(client: &Client, token: &Token) -> bool {
    match &client.identity {
        Identity::Dm => true,
        Identity::Player(id) => matches!(&token.owner, Owner::Player(owner) if owner == id),
    }
}

/// The roster is not persisted: it is a constant, and a saved copy would only
/// be able to disagree with it. It becomes state when the DM can edit it.
fn default_roster() -> Vec<RosterEntry> {
    ROSTER
        .iter()
        .map(|(id, name)| RosterEntry {
            id: PlayerId::new(id),
            name: (*name).to_owned(),
        })
        .collect()
}

impl RoomState {
    /// A room off disk. Everything the file does not carry — the DM secret, the
    /// roster, who is connected — comes from the environment or starts empty.
    fn restored(saved: Saved, dm_secret: String) -> Self {
        Self {
            dm_secret,
            roster: default_roster(),
            map: saved.map,
            staged: saved.staged,
            tokens: saved
                .tokens
                .into_iter()
                .map(|t| (t.id.clone(), t))
                .collect(),
            initiative: saved.initiative,
            shapes: saved.shapes,
            walls: saved.walls,
            calibrations: saved.calibrations,
            clients: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    fn to_saved(&self) -> Saved {
        let mut tokens: Vec<Token> = self.tokens.values().cloned().collect();
        // Same reason `snapshot_for` sorts: `HashMap` order varies per process,
        // so without this the file churns on every save and every restart.
        tokens.sort_by(|a, b| a.id.cmp(&b.id));

        Saved {
            map: self.map.clone(),
            staged: self.staged.clone(),
            tokens,
            initiative: self.initiative.clone(),
            shapes: self.shapes.clone(),
            walls: self.walls.clone(),
            calibrations: self.calibrations.clone(),
        }
    }

    /// The room a first boot starts from, with no save on disk yet. Milestone 6
    /// replaces the map from the browser.
    fn hardcoded(dm_secret: String) -> Self {
        let specs: [(&str, &str, f32, f32, Owner); 7] = [
            ("t1", "Grog", 3.5, 3.5, Owner::Player(PlayerId::new("grog"))),
            ("t2", "Vex", 4.5, 2.5, Owner::Player(PlayerId::new("vex"))),
            (
                "t3",
                "Pike",
                13.5,
                2.5,
                Owner::Player(PlayerId::new("pike")),
            ),
            ("t4", "Nyx", 12.5, 3.5, Owner::Player(PlayerId::new("nyx"))),
            ("t5", "Bram", 5.5, 4.5, Owner::Player(PlayerId::new("bram"))),
            ("t6", "Ogre", 14.5, 9.5, Owner::Dm),
            ("t7", "Wraith", 21.5, 4.5, Owner::Dm),
        ];

        Self {
            dm_secret,
            roster: default_roster(),
            map: MapInfo {
                url: "/assets/map.png".to_owned(),
                ..MapInfo::default()
            },
            staged: None,
            initiative: Initiative::default(),
            tokens: specs
                .into_iter()
                .map(|(id, name, x, y, owner)| {
                    let id = TokenId::new(id);
                    let token = Token {
                        id: id.clone(),
                        name: name.to_owned(),
                        x,
                        y,
                        owner,
                        img: format!("/assets/tokens/{}.png", name.to_lowercase()),
                        // The DM resizes anything that should be bigger. A
                        // first-boot room is a starting point, not a scene.
                        ..Token::default()
                    };
                    (id, token)
                })
                .collect(),
            shapes: Vec::new(),
            walls: Vec::new(),
            calibrations: HashMap::new(),
            clients: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    /// Returns whether the room now holds a change worth writing to disk.
    fn handle(&mut self, origin: ClientId, msg: ClientMsg) -> bool {
        // The handshake is the one thing an unidentified connection may do, so
        // it runs ahead of the permission check rather than through it.
        if let ClientMsg::Hello {
            dm_secret,
            player_id,
        } = msg
        {
            self.hello(origin, dm_secret, player_id);
            // Identity is per-connection and dies with the socket.
            return false;
        }

        if let Err(reason) = self.check(origin, &msg) {
            self.send_to(origin, ServerMsg::Error { message: reason });
            return false;
        }

        let events = self.apply(origin, msg);
        self.dispatch(origin, &events);
        events.iter().any(persists)
    }

    /// Resolve a connection's identity. A DM secret wins; otherwise a
    /// `player_id` is accepted only if it names a live roster slot, so a stale
    /// `localStorage` value from a since-edited roster falls back to the picker
    /// rather than becoming an identity nobody owns.
    fn hello(&mut self, origin: ClientId, dm_secret: Option<String>, player_id: Option<PlayerId>) {
        if self.clients.contains_key(&origin) {
            self.send_to(
                origin,
                ServerMsg::Error {
                    message: "already joined".to_owned(),
                },
            );
            return;
        }

        let Some(out) = self.pending.remove(&origin) else {
            return; // unknown connection; nothing to answer on
        };

        let identity = match (dm_secret, player_id) {
            (Some(secret), _) => {
                if secret == self.dm_secret {
                    Some(Identity::Dm)
                } else {
                    warn!(?origin, "rejected a bad DM secret");
                    let _ = out.try_send(ServerMsg::Error {
                        message: "that DM link is not valid".to_owned(),
                    });
                    None
                }
            }
            (None, Some(id)) if self.roster.iter().any(|entry| entry.id == id) => {
                Some(Identity::Player(id))
            }
            _ => None,
        };

        let Some(identity) = identity else {
            let _ = out.try_send(ServerMsg::ChooseIdentity {
                roster: self.roster_slots(),
            });
            self.pending.insert(origin, out); // still connected, still anonymous
            return;
        };

        // Invariant 3: the join snapshot goes through the same path as every
        // delta. There is no `snapshot()` to accidentally reach for.
        let welcome = ServerMsg::Welcome {
            your_id: origin,
            is_dm: identity == Identity::Dm,
            player_id: match &identity {
                Identity::Dm => None,
                Identity::Player(id) => Some(id.clone()),
            },
            state: Box::new(self.snapshot_for(&identity)),
            roster: self.roster.clone(),
        };

        if out.try_send(welcome).is_err() {
            warn!(?origin, "client vanished before Welcome could be sent");
            return;
        }

        debug!(
            ?origin,
            ?identity,
            connected = self.clients.len() + 1,
            "client joined"
        );
        self.clients.insert(origin, Client { out, identity });
        self.refresh_pickers();
    }

    /// A slot is claimed while someone is connected as it. Nothing persists —
    /// disconnecting frees it.
    fn roster_slots(&self) -> Vec<RosterSlot> {
        self.roster
            .iter()
            .map(|entry| RosterSlot {
                id: entry.id.clone(),
                name: entry.name.clone(),
                claimed: self
                    .clients
                    .values()
                    .any(|c| c.identity == Identity::Player(entry.id.clone())),
            })
            .collect()
    }

    /// Re-sends the roster to everyone still on the picker, so a slot taken
    /// while they were deciding stops looking free.
    fn refresh_pickers(&self) {
        if self.pending.is_empty() {
            return;
        }
        let roster = self.roster_slots();
        for out in self.pending.values() {
            let _ = out.try_send(ServerMsg::ChooseIdentity {
                roster: roster.clone(),
            });
        }
    }

    /// Invariant 3. The staged map is the first thing this actually withheld
    /// rather than merely being shaped to; hidden tokens and hit points are the
    /// first things it withholds *from inside* something the table does see.
    ///
    /// Every route out of the room narrows here in the same three ways a delta
    /// does — a hidden token is dropped, what survives is redacted through
    /// `view_for`, and the panel is rebuilt without the rows that went. Filtering
    /// deltas correctly and then handing over the whole world on connect is the
    /// most common way hidden state leaks, which is why there is no `snapshot()`.
    fn snapshot_for(&self, identity: &Identity) -> RoomView {
        let is_dm = matches!(identity, Identity::Dm);

        let mut tokens: Vec<TokenView> = self
            .tokens
            .values()
            .filter(|token| is_dm || !token.unseen())
            .map(|token| token.view_for(is_dm))
            .collect();
        // `HashMap` iteration order varies per process, and the client treats
        // list order as z-order. Without this, two tabs can disagree about
        // which of two overlapping tokens is on top.
        tokens.sort_by(|a, b| a.id.cmp(&b.id));

        RoomView {
            map: self.map.clone(),
            staged: match identity {
                Identity::Dm => self.staged.clone(),
                Identity::Player(_) => None,
            },
            tokens,
            initiative: self.initiative_for(is_dm),
            shapes: self.shapes_for(is_dm),
            // All of them or none, with no middle case to get wrong: a wall is
            // the dungeon's floor plan, and a player is meant to infer it from
            // the edges of the fog rather than read it out of their snapshot.
            // Empty is also what a map nobody has traced looks like.
            walls: if is_dm {
                self.walls.clone()
            } else {
                Vec::new()
            },
        }
    }

    /// The drawings as this recipient may see them.
    ///
    /// One rule today: a shape anchored to a token they cannot see is not sent.
    /// The roadmap files that under fog of war, but it is due now — `hidden`
    /// already exists, and an aura drawn on a monster the DM has taken off the
    /// board is that monster's position rendered in colour. Invariant 4 does not
    /// wait for the milestone that motivated it.
    ///
    /// Asked through `Token::unseen`, so a shape anchored to something built on
    /// the next map is withheld by the same line. A shape whose anchor is not in
    /// the room at all cannot happen — deleting a token takes its shapes — and
    /// is withheld anyway, because this fails closed on purpose.
    ///
    /// Unanchored shapes are visible to everyone. Fog will narrow that to the
    /// cells they cover; there is nothing to narrow it by yet.
    fn shapes_for(&self, is_dm: bool) -> Vec<Shape> {
        self.shapes
            .iter()
            .filter(|shape| is_dm || self.shape_seen(shape))
            .cloned()
            .collect()
    }

    /// Whether the table may see this shape at all.
    fn shape_seen(&self, shape: &Shape) -> bool {
        match shape.anchor() {
            None => true,
            Some(id) => self.tokens.get(id).is_some_and(|t| !t.unseen()),
        }
    }

    /// Whether anything drawn follows this token — the question that decides
    /// whether hiding or deleting it has to rebuild anyone's board.
    ///
    /// Gating on it matters: emitting `ShapesChanged` every time a token is
    /// hidden would tell the table *something happened* on every hide, which is
    /// news they are not entitled to. Same rule the initiative panel follows.
    fn anchors_a_shape(&self, id: &TokenId) -> bool {
        self.shapes.iter().any(|s| s.anchor() == Some(id))
    }

    /// The turn order as this recipient may see it: rows naming a token they
    /// cannot see are gone, and `current` with them.
    ///
    /// Dropping the row is not cosmetic. The panel names its rows by looking the
    /// token up in the scene, so a row the client has no token for draws as a
    /// raw id — a monster the DM hid, advertised by the one panel that is always
    /// on screen. `current` goes for the same reason: it is an id, and an id is
    /// data. The table sees the round advance past somebody they cannot see,
    /// which is exactly what is happening.
    fn initiative_for(&self, is_dm: bool) -> Initiative {
        if is_dm {
            return self.initiative.clone();
        }

        let unseen = |token: &TokenId| {
            // An entry naming no token cannot happen — deleting a token takes
            // its row — but treating it as visible keeps this total either way.
            // Nor can one name a staged-only token, which `check` refuses; the
            // predicate covers it anyway rather than depending on that.
            self.tokens.get(token).is_some_and(Token::unseen)
        };

        Initiative {
            entries: self
                .initiative
                .entries
                .iter()
                .filter(|entry| !unseen(&entry.token))
                .cloned()
                .collect(),
            current: self.initiative.current.clone().filter(|t| !unseen(t)),
            round: self.initiative.round,
        }
    }

    /// Whether a connected client is the DM. `message_for` holds `&self` and a
    /// recipient id rather than a `Client`, so the lookup lives here.
    fn is_dm(&self, client: ClientId) -> bool {
        matches!(
            self.clients.get(&client),
            Some(Client {
                identity: Identity::Dm,
                ..
            })
        )
    }

    /// Refuses anything about the staged slot while that slot is empty. `what`
    /// completes "there is no map to …".
    ///
    /// This is not the server learning that the DM is previewing — preview is
    /// client-only and stays that way. It is the same rule `PromoteStaged` and
    /// `ClearStaged` already follow: staged token state belongs to the staged
    /// map, so without one there is nothing for it to belong to. Allowing it
    /// would mint a token absent from the live board with no staged board to
    /// appear on either, which is a token nobody — the DM included — can reach.
    fn staged_slot(&self, what: &str) -> Result<(), String> {
        if self.staged.is_some() {
            Ok(())
        } else {
            Err(format!("there is no map to {what}"))
        }
    }

    /// Step 2. An unidentified connection can do nothing at all.
    fn check(&self, origin: ClientId, msg: &ClientMsg) -> Result<(), String> {
        let Some(client) = self.clients.get(&origin) else {
            return Err("join the room before sending commands".to_owned());
        };

        match msg {
            // Handled ahead of this in `handle`; reaching it means a client that
            // already has an identity tried to change it.
            ClientMsg::Hello { .. } => Err("already joined".to_owned()),
            ClientMsg::MoveToken {
                id, x, y, staged, ..
            } => {
                let Some(token) = self.tokens.get(id) else {
                    return Err(format!("no such token: {}", id.0));
                };
                if *staged {
                    // A plan is a DM-only field about a map only the DM has.
                    require_dm(client, "plan where a token lands")?;
                    self.staged_slot("plan a move on")?;
                } else if token.staged_only {
                    // The complement of the rule above rather than a new one:
                    // this token has no position on the board to move, only a
                    // plan for one. The client never offers it — a staged-only
                    // token is absent from the live board — so reaching here
                    // means a frame that would write a field the next promote
                    // immediately overwrites.
                    return Err(format!("{} is not on the board yet", token.name));
                }
                if !can_move(client, token) {
                    return Err(format!("{} is not yours to move", token.name));
                }
                finite(&[*x, *y])
            }

            ClientMsg::CreateToken {
                name,
                img,
                size,
                x,
                y,
                hp,
                staged,
                ..
            } => {
                require_dm(client, "create tokens")?;
                if *staged {
                    self.staged_slot("build a token on")?;
                }
                if self.tokens.len() >= MAX_TOKENS {
                    return Err(format!("this room already holds {MAX_TOKENS} tokens"));
                }
                token_fields(name, img, *size, *hp)?;
                finite(&[*x, *y])
            }

            ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                hp,
                ..
            } => {
                require_dm(client, "change a token")?;
                if !self.tokens.contains_key(id) {
                    return Err(format!("no such token: {}", id.0));
                }
                token_fields(name, img, *size, *hp)
            }

            ClientMsg::DeleteToken { id } => {
                require_dm(client, "delete tokens")?;
                if self.tokens.contains_key(id) {
                    Ok(())
                } else {
                    Err(format!("no such token: {}", id.0))
                }
            }

            // Which slot this is for makes no difference here: a grid size or a
            // play area is no more or less usable for being staged, so both go
            // through one set of bounds rather than two that could drift.
            ClientMsg::SetMap {
                url,
                grid_px,
                offset_x,
                offset_y,
                grid_color,
                play_area,
                staged: _,
            } => {
                require_dm(client, "change the map")?;
                if url.is_empty() || url.len() > MAX_URL_LEN {
                    return Err("that is not a usable map URL".to_owned());
                }
                finite(&[*grid_px, *offset_x, *offset_y])?;
                if !(MIN_GRID_PX..=MAX_GRID_PX).contains(grid_px) {
                    return Err(format!(
                        "a grid cell must be between {MIN_GRID_PX:.0} and {MAX_GRID_PX:.0} pixels"
                    ));
                }
                if !is_hex_rgba(grid_color) {
                    return Err("a grid colour must look like #rrggbbaa".to_owned());
                }
                if let Some(area) = play_area {
                    finite(&[area.x, area.y, area.w, area.h])?;
                    // Bounded, and not merely positive: the client rules one
                    // grid line per cell across this width, so an absurd size
                    // here is a frozen browser rather than a silly-looking map.
                    if !(0.0..=MAX_MAP_PX).contains(&area.w)
                        || !(0.0..=MAX_MAP_PX).contains(&area.h)
                    {
                        return Err("that play area is not a usable size".to_owned());
                    }
                    if area.w < *grid_px || area.h < *grid_px {
                        return Err("a play area must be at least one cell across".to_owned());
                    }
                }
                Ok(())
            }

            // Refused rather than quietly doing nothing, the way deleting a
            // token that is not there is refused: both mean the DM's panel and
            // the room disagree about what exists, and saying so is how that
            // gets noticed.
            ClientMsg::PromoteStaged | ClientMsg::ClearStaged => {
                require_dm(client, "change the map")?;
                if self.staged.is_some() {
                    Ok(())
                } else {
                    Err("there is no map staged".to_owned())
                }
            }

            // No `require_dm` anywhere in this group but the last: anyone may
            // draw. The permission that does exist is on erasing, and it is
            // per-shape rather than per-role.
            ClientMsg::Sketch { at, to, color, .. } => {
                finite(&[at.x, at.y])?;
                shape_fields(*to, color)
            }

            ClientMsg::AddShape {
                from, to, color, ..
            } => {
                if self.shapes.len() >= MAX_SHAPES {
                    return Err(format!("this board already holds {MAX_SHAPES} drawings"));
                }
                match from {
                    Origin::Point(at) => finite(&[at.x, at.y])?,
                    Origin::Token(id) => {
                        // Refused for a token this client cannot see, and with
                        // the same words either way. Answering "no such token"
                        // for one that does exist but is hidden would make this
                        // an oracle: sweep the id space and the refusals map
                        // out the DM's monsters.
                        let seen = self
                            .tokens
                            .get(id)
                            .is_some_and(|t| client.identity == Identity::Dm || !t.unseen());
                        if !seen {
                            return Err(format!("no such token: {}", id.0));
                        }
                    }
                }
                shape_fields(*to, color)
            }

            ClientMsg::RemoveShape { id } => {
                // Filtered before it is found, so a shape this client is not
                // sent is a shape that does not exist as far as they are
                // concerned — they cannot erase it, and the refusal cannot tell
                // them apart from an id nobody ever held.
                let Some(shape) = self
                    .shapes
                    .iter()
                    .find(|s| &s.id == id)
                    .filter(|s| client.identity == Identity::Dm || self.shape_seen(s))
                else {
                    return Err("that drawing is already gone".to_owned());
                };
                if can_erase(client, shape) {
                    Ok(())
                } else {
                    Err("that is not yours to erase".to_owned())
                }
            }

            // The one DM-only command here, because it reaches into five other
            // people's drawings rather than only their own.
            ClientMsg::ClearShapes => require_dm(client, "clear the board"),

            // Every wall command is DM-only, and unlike the drawings there is no
            // per-item permission underneath: the walls are all the DM's, so
            // "may this client touch a wall" and "is this client the DM" are the
            // same question.
            ClientMsg::AddWalls { points, .. } => {
                require_dm(client, "trace walls")?;
                // Two points make one segment. One is a click that started a run
                // and never finished it, which the client does not send — so
                // reaching here is a frame that would store nothing.
                if points.len() < 2 {
                    return Err("a wall needs at least two corners".to_owned());
                }
                if points.len() > MAX_WALL_POINTS {
                    return Err(format!(
                        "a single run may not exceed {MAX_WALL_POINTS} corners"
                    ));
                }
                // The run becomes one segment per gap between corners, so this
                // is what the room is actually being asked to grow by.
                if self.walls.len() + points.len() - 1 > MAX_WALLS {
                    return Err(format!("this map already holds {MAX_WALLS} wall segments"));
                }
                for point in points {
                    finite(&[point.x, point.y])?;
                    // Image pixels, so the same bound the play area is held to
                    // and for the same reason — this is geometry over the art.
                    // Negative is allowed: the map is drawn from the world
                    // origin, but a DM tracing right up to the edge should not
                    // have a corner refused for landing a pixel outside it.
                    if point.x.abs() > MAX_MAP_PX || point.y.abs() > MAX_MAP_PX {
                        return Err("that wall is not on the map".to_owned());
                    }
                }
                Ok(())
            }

            // "Already gone" rather than "no such wall", the way erasing a shape
            // reads. There is nothing to leak here — a player cannot get this
            // far — but the DM's client can race itself with two tabs open, and
            // a refusal that describes the outcome is more use than one that
            // describes the lookup.
            ClientMsg::RemoveWall { id } => {
                require_dm(client, "erase walls")?;
                if self.walls.iter().any(|w| &w.id == id) {
                    Ok(())
                } else {
                    Err("that wall is already gone".to_owned())
                }
            }

            ClientMsg::ToggleDoor { id } => {
                require_dm(client, "open and close doors")?;
                match self.walls.iter().find(|w| &w.id == id) {
                    Some(wall) if wall.door().is_some() => Ok(()),
                    // Refused rather than ignored: a toggle that lands on
                    // masonry means the client and the room disagree about what
                    // that segment is, and quietly doing nothing hides it.
                    Some(_) => Err("that is a wall, not a door".to_owned()),
                    None => Err("that wall is already gone".to_owned()),
                }
            }

            ClientMsg::ClearWalls => require_dm(client, "clear the walls"),

            ClientMsg::SetInitiative { token, .. } => {
                require_dm(client, "change initiative")?;
                let Some(named) = self.tokens.get(token) else {
                    return Err(format!("no such token: {}", token.0));
                };
                // Refused the way a token that does not exist is refused, and
                // for the same reason: on the board it is a creature that is not
                // there. Combat is the fight happening now, and building next
                // room's order in advance needs rolls nobody has made.
                if named.staged_only {
                    return Err(format!("{} is not on the board yet", named.name));
                }
                Ok(())
            }

            ClientMsg::RemoveFromInitiative { .. }
            | ClientMsg::ClearInitiative
            | ClientMsg::NextTurn
            | ClientMsg::PreviousTurn => require_dm(client, "change initiative"),
        }
    }

    /// Step 3. Mutates state, returns what happened.
    ///
    /// `origin` is here for the drawing commands and nothing else. Every command
    /// before them was checked against who sent it and then applied identically
    /// whoever that was; a sketch belongs to the connection that swept it, and a
    /// kept shape records who drew it, so these are the first whose *effect*
    /// depends on the sender rather than only their permission to send it.
    fn apply(&mut self, origin: ClientId, msg: ClientMsg) -> Vec<Event> {
        match msg {
            ClientMsg::Hello { .. } => Vec::new(),
            ClientMsg::MoveToken {
                id,
                x,
                y,
                dragging,
                staged,
            } => {
                let Some(token) = self.tokens.get_mut(&id) else {
                    // `check` already proved this exists; belt and braces so a
                    // future reordering of the pipeline cannot panic here.
                    return Vec::new();
                };

                // In-flight drag frames stay wherever the pointer is so motion
                // reads as smooth. The drop is what settles onto the grid.
                let (x, y) = if dragging {
                    (x, y)
                } else {
                    snap_to_cell(x, y, token.size)
                };
                // The whole of routing a drag to the plan instead of the board.
                // Everything either side of this line — the throttle, the snap,
                // the debounce — is unaware there are two positions.
                if staged {
                    token.staged_pos = Some(Pos { x, y });
                } else {
                    token.x = x;
                    token.y = y;
                }

                vec![Event::TokenMoved {
                    id,
                    x,
                    y,
                    dragging,
                    staged,
                }]
            }

            ClientMsg::CreateToken {
                name,
                img,
                size,
                owner,
                x,
                y,
                hidden,
                hp,
                staged,
            } => {
                // The id is invented here rather than accepted from the client,
                // so nothing a DM sends can collide with a token that exists.
                let id = TokenId(Uuid::new_v4().simple().to_string());
                let (x, y) = snap_to_cell(x, y, size);
                self.tokens.insert(
                    id.clone(),
                    Token {
                        id: id.clone(),
                        name: name.trim().to_owned(),
                        // A staged-only token's `x, y` is a placeholder its own
                        // plan overwrites on promote, so it is set to the same
                        // cell rather than to zero: nothing ever reads it, and
                        // if the invariant that it is unreachable were ever to
                        // break, the token would be found where it was built.
                        x,
                        y,
                        owner,
                        img,
                        size,
                        hidden,
                        hp,
                        staged_pos: staged.then_some(Pos { x, y }),
                        staged_only: staged,
                    },
                );
                // Nobody held this token a moment ago, which is the same
                // position the table is in for one created hidden or built on
                // the next map: there is nothing to take away from them.
                vec![Event::TokenChanged {
                    id,
                    was_unseen: true,
                }]
            }

            ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                owner,
                hidden,
                hp,
            } => {
                let Some(token) = self.tokens.get_mut(&id) else {
                    return Vec::new(); // proved to exist by `check`
                };

                let was_unseen = token.unseen();
                token.name = name.trim().to_owned();
                token.img = img;
                token.owner = owner;
                token.hidden = hidden;
                token.hp = hp;

                // Resizing moves which lattice the token belongs on — a 2×2
                // settles on a cell corner where a 1×1 settles on a centre — so
                // growing one where it stands would leave it straddling half a
                // cell until somebody happened to drag it.
                if token.size != size {
                    token.size = size;
                    let (x, y) = snap_to_cell(token.x, token.y, size);
                    token.x = x;
                    token.y = y;
                    // The plan is a position on the same lattice and goes the
                    // same way. Missed, a token resized after being planned
                    // straddles half a cell the moment it is promoted — the
                    // original bug, deferred to the one place nobody looks.
                    token.staged_pos = token.staged_pos.map(|at| {
                        let (x, y) = snap_to_cell(at.x, at.y, size);
                        Pos { x, y }
                    });
                }
                let now_unseen = token.unseen();

                let mut events = vec![Event::TokenChanged {
                    id: id.clone(),
                    was_unseen,
                }];
                // Hiding something mid-fight takes its row off the table's panel
                // and unhiding puts it back, so the panel has to be rebuilt for
                // the same reason deleting a token rebuilds it. Without this the
                // players keep a row naming a token their client has just been
                // told to forget, which draws as a bare id — precisely the thing
                // `hidden` was asked to conceal.
                //
                // Asked of `unseen` rather than of `hidden`, so that toggling
                // the flag on a staged-only token — which the table cannot see
                // either way — rebuilds nothing.
                if was_unseen != now_unseen && self.initiative.index_of(&id).is_some() {
                    events.push(Event::InitiativeChanged);
                }
                // And the same again for what is drawn on it. An aura anchored
                // to a monster the DM has just hidden has to leave the table's
                // board with it, or the shape stays exactly where the creature
                // is standing — which is the whole of what was withheld.
                //
                // Gated on something actually being anchored to it, not merely
                // on the flip: an unconditional rebuild would tell the table
                // that *something happened* every time the DM hid anything.
                if was_unseen != now_unseen && self.anchors_a_shape(&id) {
                    events.push(Event::ShapesChanged);
                }
                events
            }

            // Its plan goes with it, like any other field on it. Nothing extra
            // to do: the plan lives on the token rather than beside it, which
            // is most of why it lives on the token.
            ClientMsg::DeleteToken { id } => self.delete_token(&id),

            // Tokens are deliberately untouched. They are stored in grid units,
            // so recalibrating changes where a token *draws* without changing
            // which cell it is in — invariant 1, and the whole reason positions
            // are not kept in pixels.
            ClientMsg::SetMap {
                url,
                grid_px,
                offset_x,
                offset_y,
                grid_color,
                play_area,
                staged,
            } => {
                let given = Calibration {
                    grid_px,
                    offset_x,
                    offset_y,
                    grid_color,
                    play_area,
                };

                // The URL alone says which of the two things this is. A URL the
                // slot is not already showing is a map being loaded, so anything
                // remembered for it wins over what the client sent — which is
                // how re-picking a map comes back calibrated without the client
                // knowing the table exists. A URL that matches what the slot
                // holds is the DM recalibrating it, which is applied as given.
                //
                // Recording only in the second case, and on a load of a map with
                // nothing remembered yet, is what keeps the two halves from
                // cancelling: if a load recorded too, a remembered calibration
                // would immediately overwrite itself with the client's guess.
                //
                // An empty staged slot holds no URL, so filling it is always a
                // load — which is what makes a map come back calibrated the
                // moment it is staged rather than only once it is promoted.
                let showing = if staged {
                    self.staged.as_ref().map(|map| &map.url)
                } else {
                    Some(&self.map.url)
                };
                let loading = showing != Some(&url);
                let calibration = match self.calibrations.get(&url) {
                    Some(remembered) if loading => remembered.clone(),
                    _ => {
                        self.calibrations.insert(url.clone(), given.clone());
                        given
                    }
                };

                // One table, keyed by URL, for both slots. Calibrating a map
                // while it is staged is what makes it arrive on the board
                // already calibrated when it is promoted.
                let finished = calibration.into_map(url);
                if staged {
                    // Staged token state belongs to the staged map and dies with
                    // it. `loading` is what tells the two cases apart, and it is
                    // the same `loading` the calibration table already turns on:
                    // a *different* map is a different next room, so the
                    // monsters placed for the last one go. A recalibration is
                    // not, and must not sweep them away — correcting the grid
                    // after placing an ambush is an ordinary thing to do, and
                    // this is the arm that gets missed.
                    let mut events = if loading {
                        self.clear_staged_tokens()
                    } else {
                        Vec::new()
                    };
                    self.staged = Some(finished);
                    events.push(Event::StagedChanged);
                    events
                } else {
                    // Deliberately not cleared here. A plan describes a cell on
                    // the staged map, which this command has not touched — the
                    // plans are still about the map they were made on.
                    self.map = finished;
                    let mut events = vec![Event::MapChanged];
                    // The drawings and the walls are the opposite case, and turn
                    // on the same `loading`: they describe this image, and a new
                    // one is a new dungeon where none of it means anything. A
                    // recalibration must leave them alone, exactly as it leaves
                    // the plans alone — this is the arm that gets missed.
                    if loading {
                        events.append(&mut self.sweep_board());
                    }
                    events
                }
            }

            // A token with no plan is still untouched here, and for a stronger
            // reason than a recalibration: it is stored in cells, and there is
            // no sensible way to carry a cell across to an unrelated image. It
            // keeps its coordinates and the DM repositions it. A plan is how the
            // DM says otherwise in advance, and this is where it comes true.
            ClientMsg::PromoteStaged => {
                let Some(map) = self.staged.take() else {
                    return Vec::new(); // proved to exist by `check`
                };
                self.map = map;

                // Tokens first, so that by the time a client is told the slot
                // has emptied — which is what ends the DM's preview — every
                // token already holds the position it landed on.
                let mut events = self.promote_staged_tokens();
                // A promote is a new map arriving on the board, so the drawings
                // and the walls go the way they go for any other load. Nothing
                // carries over: there are no staged shapes or staged walls to
                // adopt, because the staged map has neither.
                events.append(&mut self.sweep_board());
                // Then the two that were always here, because two things
                // happened: the board changed for everyone, and the slot emptied
                // for the DM.
                events.push(Event::MapChanged);
                events.push(Event::StagedChanged);
                events
            }

            ClientMsg::ClearStaged => {
                let mut events = self.clear_staged_tokens();
                self.staged = None;
                events.push(Event::StagedChanged);
                events
            }

            // Relayed and forgotten. The room does not hold the sweep at all —
            // there is nothing to hold, since the next frame replaces it and the
            // release ends it. That is what makes a measuring line cost the save
            // file nothing, and it is why a client joining mid-sweep is sent no
            // sketch: `RoomView` can only describe what the room knows.
            ClientMsg::Sketch {
                kind,
                at,
                to,
                color,
                drawing,
            } => {
                if drawing {
                    vec![Event::Sketching {
                        by: origin,
                        kind,
                        at,
                        to,
                        color,
                    }]
                } else {
                    vec![Event::SketchEnded { by: origin }]
                }
            }

            ClientMsg::AddShape {
                kind,
                from,
                to,
                color,
            } => {
                // The id is the server's to invent, like a token's, so two
                // people drawing at once cannot propose the same one.
                let by = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // Proved to be a client by `check`. Falling back to the DM
                    // is the closed door: it is the identity that can erase it.
                    None => Owner::Dm,
                };
                self.shapes.push(Shape {
                    id: ShapeId(Uuid::new_v4().simple().to_string()),
                    kind,
                    from,
                    to,
                    by,
                    color,
                });
                vec![Event::ShapesChanged]
            }

            ClientMsg::RemoveShape { id } => {
                self.shapes.retain(|s| s.id != id);
                vec![Event::ShapesChanged]
            }

            ClientMsg::ClearShapes => {
                self.shapes.clear();
                vec![Event::ShapesChanged]
            }

            // One run in, one segment per gap between its corners out. The run
            // itself is not stored — it was how the DM drew, not what the map
            // holds — which is what lets one bad segment of a long trace be
            // erased without redrawing the rest of it.
            ClientMsg::AddWalls { points, door } => {
                let kind = if door {
                    // Traced shut. A door the DM has to close after drawing it is
                    // a door they will forget to close, and a dungeon's doors are
                    // shut until somebody opens them.
                    WallKind::Door(false)
                } else {
                    WallKind::Solid
                };
                for pair in points.windows(2) {
                    let [from, to] = pair else { continue };
                    self.walls.push(Wall {
                        // The server's to invent, like a shape's or a token's.
                        id: WallId(Uuid::new_v4().simple().to_string()),
                        from: *from,
                        to: *to,
                        kind,
                    });
                }
                vec![Event::WallsChanged]
            }

            ClientMsg::RemoveWall { id } => {
                self.walls.retain(|w| w.id != id);
                vec![Event::WallsChanged]
            }

            ClientMsg::ToggleDoor { id } => {
                for wall in &mut self.walls {
                    if wall.id == id {
                        // Proved to be a door by `check`; masonry is left alone
                        // rather than turned into one.
                        if let WallKind::Door(open) = wall.kind {
                            wall.kind = WallKind::Door(!open);
                        }
                    }
                }
                vec![Event::WallsChanged]
            }

            ClientMsg::ClearWalls => {
                self.walls.clear();
                vec![Event::WallsChanged]
            }

            ClientMsg::SetInitiative { token, value } => {
                self.initiative.set(token, value);
                vec![Event::InitiativeChanged]
            }
            ClientMsg::RemoveFromInitiative { token } => {
                self.initiative.remove(&token);
                vec![Event::InitiativeChanged]
            }
            ClientMsg::ClearInitiative => {
                self.initiative.clear();
                vec![Event::InitiativeChanged]
            }
            ClientMsg::NextTurn => {
                self.initiative.next_turn();
                vec![Event::InitiativeChanged]
            }
            ClientMsg::PreviousTurn => {
                self.initiative.previous_turn();
                vec![Event::InitiativeChanged]
            }
        }
    }

    /// Everything drawn or traced over the map image, thrown away because that
    /// image is being replaced.
    ///
    /// Shared by a load into the live slot and by a promote, which is a load. It
    /// is deliberately *not* reached by a recalibration: the drawings are cells
    /// on this board and the walls trace this art, and correcting the grid
    /// changes neither of those facts.
    ///
    /// Both halves are gated on being non-empty, and that is not tidiness. An
    /// unconditional `ShapesChanged` on every map load tells the table something
    /// happened to a board that had nothing on it — the same gate the initiative
    /// panel uses, for the third time. `WallsChanged` reaches the DM alone, who
    /// is the one doing this, so the gate there is merely honest.
    fn sweep_board(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        if !self.shapes.is_empty() {
            self.shapes.clear();
            events.push(Event::ShapesChanged);
        }
        // Half an hour of tracing, gone with one map load and no undo. That is
        // the same bargain the drawings make and the roadmap asks for — walls
        // are grid- and art-specific, and a wall traced on the last dungeon is
        // a line across the middle of this one.
        if !self.walls.is_empty() {
            self.walls.clear();
            events.push(Event::WallsChanged);
        }
        events
    }

    /// Takes a token out of the room, and its initiative row with it.
    ///
    /// Shared by `DeleteToken` and by the sweep that throws away a staged map,
    /// which deletes the tokens that only existed on it. The order would
    /// otherwise keep a row pointing at a token that no longer exists — which
    /// the panel renders as a bare id, and which `next_turn` would hand the turn
    /// to. A staged-only token cannot be in the order, so that half is dead code
    /// on one of the two paths; sharing one function is still worth more than
    /// two that could come to disagree about what deleting means.
    fn delete_token(&mut self, id: &TokenId) -> Vec<Event> {
        let Some(gone) = self.tokens.remove(id) else {
            return Vec::new();
        };

        let mut events = vec![Event::TokenRemoved {
            id: id.clone(),
            was_unseen: gone.unseen(),
        }];
        if self.initiative.index_of(id).is_some() {
            self.initiative.remove(id);
            events.push(Event::InitiativeChanged);
        }
        // Anything anchored to it goes the same way, and for the same reason the
        // initiative row does: a shape following a token that no longer exists
        // has no position to be drawn at. The roadmap called this one in
        // advance, and it is the second thing deleting a token now reaches into.
        if self.anchors_a_shape(id) {
            self.shapes.retain(|s| s.anchor() != Some(id));
            events.push(Event::ShapesChanged);
        }
        events
    }

    /// Everything the staged map owned, thrown away with it: every plan is
    /// cleared and every token that only existed on that map is deleted.
    ///
    /// Without this the next map inherits monsters placed on a map nobody will
    /// ever see again — and, worse, staged-only tokens that no board shows,
    /// since the live one does not draw them and the map they were built on is
    /// gone. Reached from `ClearStaged` and from a *load* into the staged slot.
    ///
    /// Every event it produces reaches the DM alone: a deleted staged-only token
    /// was never announced, and a cleared plan is a field no player holds.
    fn clear_staged_tokens(&mut self) -> Vec<Event> {
        let mut doomed: Vec<TokenId> = Vec::new();
        let mut planned: Vec<TokenId> = Vec::new();
        for token in self.tokens.values() {
            if token.staged_only {
                doomed.push(token.id.clone());
            } else if token.staged_pos.is_some() {
                planned.push(token.id.clone());
            }
        }
        // `HashMap` order varies per process, and these ids decide the order of
        // the frames the DM's other tabs receive. Sorted for the same reason
        // `snapshot_for` sorts: two clients must not be handed one burst in two
        // different orders.
        doomed.sort();
        planned.sort();

        let mut events: Vec<Event> = Vec::new();
        for id in doomed {
            events.extend(self.delete_token(&id));
        }
        for id in planned {
            if let Some(token) = self.tokens.get_mut(&id) {
                token.staged_pos = None;
            }
            events.push(Event::TokenPlanChanged { id });
        }
        events
    }

    /// Every plan comes true: a planned token adopts its `staged_pos` as its
    /// position, a staged-only token becomes an ordinary one, and both fields
    /// are emptied because the map they belonged to has just stopped being the
    /// next one.
    ///
    /// The one moment the whole table sees a batch of changes at once.
    fn promote_staged_tokens(&mut self) -> Vec<Event> {
        let mut ids: Vec<TokenId> = self
            .tokens
            .values()
            .filter(|t| t.staged_only || t.staged_pos.is_some())
            .map(|t| t.id.clone())
            .collect();
        ids.sort(); // stable frame order, as above

        ids.into_iter()
            .filter_map(|id| {
                let token = self.tokens.get_mut(&id)?;
                let was_unseen = token.unseen();
                token.staged_only = false;

                let moved = match token.staged_pos.take() {
                    // Already snapped when the plan was set, and to the same
                    // lattice: a position is a position whichever board it was
                    // chosen on, which is the whole reason this is one field
                    // rather than a second world.
                    Some(at) => {
                        let moved = (token.x, token.y) != (at.x, at.y);
                        token.x = at.x;
                        token.y = at.y;
                        moved
                    }
                    None => false,
                };

                Some(Event::Promoted {
                    id,
                    was_unseen,
                    moved,
                })
            })
            .collect()
    }

    /// Step 4. Every event is offered to every identified client individually.
    fn dispatch(&mut self, origin: ClientId, events: &[Event]) {
        let mut wedged: Vec<ClientId> = Vec::new();

        for (&recipient, client) in &self.clients {
            for event in events {
                let Some(msg) = self.message_for(recipient, origin, event) else {
                    continue;
                };
                if client.out.try_send(msg).is_err() {
                    wedged.push(recipient);
                    break;
                }
            }
        }

        for client in wedged {
            // Dropping the sender ends that connection's send task, which
            // closes its socket. Better than stalling the room on one bad peer.
            warn!(?client, "outbound mailbox full, dropping client");
            self.clients.remove(&client);
        }
    }

    /// The visibility filter. One `Event` in, at most one `ServerMsg` out, per
    /// recipient. Fog of war grows here — it is the reason `Event` and
    /// `ServerMsg` are separate types.
    fn message_for(
        &self,
        recipient: ClientId,
        origin: ClientId,
        event: &Event,
    ) -> Option<ServerMsg> {
        match event {
            Event::TokenMoved {
                id,
                x,
                y,
                dragging,
                staged,
            } => {
                // The originator is already drawing this from its own local
                // prediction; echoing mid-drag frames back rubber-bands it. The
                // drop frame is echoed, because it carries the server's snap and
                // is the only way the originator learns its settled position.
                // True of a plan being dragged into place as much as a token.
                if *dragging && recipient == origin {
                    return None;
                }
                if !self.is_dm(recipient) {
                    // A plan is a cell on a map the table has not been shown, so
                    // the frame carrying one exists for the DM alone — the same
                    // arm `StagedChanged` is, reaching one token instead of the
                    // whole board.
                    if *staged {
                        return None;
                    }
                    // A creature the table cannot see does not move where they
                    // can watch it. Position is data, and thirty frames a second
                    // of it would trace an invisible monster's path across the
                    // board.
                    if self.tokens.get(id).is_some_and(Token::unseen) {
                        return None;
                    }
                }
                Some(ServerMsg::TokenMoved {
                    id: id.clone(),
                    x: *x,
                    y: *y,
                    dragging: *dragging,
                    staged: *staged,
                })
            }

            // Read off `&self` per recipient rather than carried on the event,
            // which is what lets one event leave here as three different things.
            // The DM gets the token; a player gets a redacted copy if they may
            // see it, the news that it is gone if it has just been hidden, and
            // nothing at all if it was already hidden — that last case matters,
            // because a `TokenRemoved` naming an id they never held would tell
            // them a token exists, which is the whole thing being withheld.
            Event::TokenChanged { id, was_unseen } => {
                let token = self.tokens.get(id)?;
                let is_dm = self.is_dm(recipient);

                if is_dm || !token.unseen() {
                    Some(ServerMsg::TokenChanged {
                        token: token.view_for(is_dm),
                    })
                } else if *was_unseen {
                    None
                } else {
                    Some(ServerMsg::TokenRemoved { id: id.clone() })
                }
            }

            Event::TokenRemoved { id, was_unseen } => {
                if *was_unseen && !self.is_dm(recipient) {
                    return None;
                }
                Some(ServerMsg::TokenRemoved { id: id.clone() })
            }

            // The `StagedChanged` shape at token scale: dropped for who the
            // recipient is, not for anything they did. A player's copy of this
            // token is identical either side of the change, so the only thing a
            // frame could carry them is the news that the DM just discarded a
            // plan — which is news.
            Event::TokenPlanChanged { id } => {
                let token = self.tokens.get(id)?;
                self.is_dm(recipient).then(|| ServerMsg::TokenChanged {
                    token: token.view_for(true),
                })
            }

            // The three shapes, all at once. The DM needs a whole token: their
            // client holds `staged_pos` and `staged_only`, which have just been
            // emptied, and no `TokenMoved` could tell them so. A player meeting
            // the token for the first time needs a whole one too, for the
            // ordinary reason — they have never held it. A player who has been
            // watching it all along needs only where it went, and one that has
            // not moved needs nothing at all.
            Event::Promoted {
                id,
                was_unseen,
                moved,
            } => {
                let token = self.tokens.get(id)?;
                if self.is_dm(recipient) {
                    return Some(ServerMsg::TokenChanged {
                        token: token.view_for(true),
                    });
                }
                // Still hidden. A promote settles `staged_only`; it says nothing
                // about a monster the DM also took off the board.
                if token.unseen() {
                    return None;
                }
                if *was_unseen {
                    return Some(ServerMsg::TokenChanged {
                        token: token.view_for(false),
                    });
                }
                moved.then(|| ServerMsg::TokenMoved {
                    id: id.clone(),
                    x: token.x,
                    y: token.y,
                    // Not a drag frame: it is the settled position, and it is
                    // the first the table hears of it.
                    dragging: false,
                    staged: false,
                })
            }

            // Built per recipient rather than carried on the event, which is
            // what lets the table's panel be a shorter list than the DM's.
            Event::InitiativeChanged => Some(ServerMsg::InitiativeChanged {
                initiative: self.initiative_for(self.is_dm(recipient)),
            }),

            // Echoed to the DM who sent it as well. Unlike a token drag there is
            // no local prediction to rubber-band: the client draws the grid the
            // server confirmed, so this frame is how the DM sees the result.
            Event::MapChanged => Some(ServerMsg::MapChanged {
                map: self.map.clone(),
            }),

            // The filter doing its actual job. Every arm above drops a message
            // for something the recipient *did*; this one drops it for who the
            // recipient is, which is the shape hidden tokens and fog need. A
            // player is not sent a staged map and told not to draw it — the
            // frame does not exist for them at all.
            Event::StagedChanged => self.is_dm(recipient).then(|| ServerMsg::StagedChanged {
                map: self.staged.clone(),
            }),

            // Keyed on `by` rather than on `origin`, which are the same client
            // for a live sweep and are not on a disconnect — the frame that ends
            // a stranded sketch is dispatched with the departed client as both,
            // and it is the recipients who are still here that matter.
            //
            // The sweeper is skipped for `TokenMoved`'s reason: they are drawing
            // it from their own pointer already, and an echo arriving a round
            // trip later is a line that lags behind the cursor.
            Event::Sketching {
                by,
                kind,
                at,
                to,
                color,
            } => (recipient != *by).then(|| ServerMsg::Sketch {
                by: *by,
                kind: *kind,
                at: *at,
                to: *to,
                color: color.clone(),
            }),

            Event::SketchEnded { by } => {
                (recipient != *by).then_some(ServerMsg::SketchEnded { by: *by })
            }

            // Built per recipient, like the initiative panel and for the same
            // reason: the DM's board and the table's genuinely differ, and this
            // is the seam an aura on a hidden monster is dropped at.
            Event::ShapesChanged => Some(ServerMsg::ShapesChanged {
                shapes: self.shapes_for(self.is_dm(recipient)),
            }),

            // `StagedChanged`'s arm again, and the least ambiguous case of it:
            // there is no filtered version of a wall for a player to receive.
            // Not an empty list either — a frame carrying nothing still says the
            // DM just did something, and by the time fog exists it would say
            // *when* a door opened, on the one board they cannot see through.
            Event::WallsChanged => self.is_dm(recipient).then(|| ServerMsg::WallsChanged {
                walls: self.walls.clone(),
            }),
        }
    }

    /// Reaches identified and pending connections alike — a client that has not
    /// joined still needs to be told why its command was refused.
    fn send_to(&self, client: ClientId, msg: ServerMsg) {
        if let Some(target) = self.clients.get(&client) {
            let _ = target.out.try_send(msg);
        } else if let Some(out) = self.pending.get(&client) {
            let _ = out.try_send(msg);
        }
    }
}

/// Where a token of this size settles, in grid units.
///
/// A token is a square `size` cells across, centred on the position stored for
/// it, so where it can settle depends on how wide it is. An odd width has a
/// middle cell and settles on that cell's centre — a 1×1 in cell (0,0) is at
/// (0.5, 0.5). An even width has no middle cell and settles on the corner four
/// cells meet at, so a 2×2 covering cells (0,0) to (1,1) is at (1.0, 1.0).
/// Either way its edges land on grid lines, which is the point.
///
/// Anything smaller than a cell settles like a single-cell token rather than on
/// a lattice of its own: a druid who is currently a rat belongs in the middle
/// of a square, next to the party, not tucked into one quarter of one.
///
/// This rule lives only here. The client never snaps; it learns the settled
/// position from the echoed drop frame.
fn snap_to_cell(x: f32, y: f32, size: f32) -> (f32, f32) {
    let cells = size.max(1.0) as u32;
    let centre = if cells.is_multiple_of(2) { 0.0 } else { 0.5 };
    // Not `floor`: the lattice moves with `centre`, and rounding to the nearest
    // point on it is the same sentence for both cases. `round` also does the
    // right thing below zero, where a token dragged off the top-left of the map
    // must land in cell -1 rather than folding back onto the board.
    ((x - centre).round() + centre, (y - centre).round() + centre)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the tests name these; `check` and `apply` reach a `Rect` through the
    // `Option` on the message, and a `Px` through the `Vec` on a traced run.
    use crate::protocol::{Px, Rect};

    const SECRET: &str = "test-secret";

    fn room() -> RoomState {
        RoomState::hardcoded(SECRET.to_owned())
    }

    /// Opens a connection and returns its outbound receiver.
    fn connect(state: &mut RoomState, client: ClientId) -> mpsc::Receiver<ServerMsg> {
        let (tx, rx) = mpsc::channel(16);
        state.pending.insert(client, tx);
        rx
    }

    fn join_as_player(
        state: &mut RoomState,
        client: ClientId,
        slot: &str,
    ) -> mpsc::Receiver<ServerMsg> {
        let mut rx = connect(state, client);
        state.handle(
            client,
            ClientMsg::Hello {
                dm_secret: None,
                player_id: Some(PlayerId::new(slot)),
            },
        );
        rx.try_recv().expect("welcome");
        rx
    }

    fn join_as_dm(state: &mut RoomState, client: ClientId) -> mpsc::Receiver<ServerMsg> {
        let mut rx = connect(state, client);
        state.handle(
            client,
            ClientMsg::Hello {
                dm_secret: Some(SECRET.to_owned()),
                player_id: None,
            },
        );
        rx.try_recv().expect("welcome");
        rx
    }

    // --- handshake ----------------------------------------------------------

    #[test]
    fn an_anonymous_connection_is_offered_the_roster_and_no_state() {
        let mut state = room();
        let mut rx = connect(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            ClientMsg::Hello {
                dm_secret: None,
                player_id: None,
            },
        );

        match rx.try_recv().expect("a reply") {
            ServerMsg::ChooseIdentity { roster } => assert_eq!(roster.len(), 5),
            other => panic!("expected ChooseIdentity, got {other:?}"),
        }
        assert!(
            state.clients.is_empty(),
            "must not be admitted without an identity"
        );
    }

    #[test]
    fn the_correct_dm_secret_admits_a_dm() {
        let mut state = room();
        let mut rx = connect(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            ClientMsg::Hello {
                dm_secret: Some(SECRET.to_owned()),
                player_id: None,
            },
        );

        match rx.try_recv().expect("a reply") {
            ServerMsg::Welcome {
                is_dm, player_id, ..
            } => {
                assert!(is_dm);
                assert_eq!(player_id, None, "a DM holds no roster slot");
            }
            other => panic!("expected Welcome, got {other:?}"),
        }
    }

    #[test]
    fn a_wrong_dm_secret_falls_back_to_the_picker_without_admitting_anyone() {
        let mut state = room();
        let mut rx = connect(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            ClientMsg::Hello {
                dm_secret: Some("guess".to_owned()),
                player_id: None,
            },
        );

        assert!(matches!(rx.try_recv(), Ok(ServerMsg::Error { .. })));
        assert!(matches!(
            rx.try_recv(),
            Ok(ServerMsg::ChooseIdentity { .. })
        ));
        assert!(state.clients.is_empty());
        assert!(
            state.pending.contains_key(&ClientId(1)),
            "still connected, still anonymous"
        );
    }

    #[test]
    fn a_player_id_outside_the_roster_is_not_an_identity() {
        let mut state = room();
        let mut rx = connect(&mut state, ClientId(1));

        // Stale localStorage from a roster that has since changed.
        state.handle(
            ClientId(1),
            ClientMsg::Hello {
                dm_secret: None,
                player_id: Some(PlayerId::new("ghost")),
            },
        );

        assert!(matches!(
            rx.try_recv(),
            Ok(ServerMsg::ChooseIdentity { .. })
        ));
        assert!(state.clients.is_empty());
    }

    #[test]
    fn rejoining_the_same_slot_recovers_the_same_tokens() {
        let mut state = room();
        // A refresh is a new connection claiming the same slot; ownership is by
        // slot, so nothing is orphaned.
        let _first = join_as_player(&mut state, ClientId(1), "vex");
        state.clients.remove(&ClientId(1)); // the old socket closes
        let _second = join_as_player(&mut state, ClientId(2), "vex");

        let client = state.clients.get(&ClientId(2)).expect("rejoined");
        let vex_token = state.tokens.get(&TokenId::new("t2")).expect("t2");
        assert!(can_move(client, vex_token));
    }

    // --- permissions --------------------------------------------------------

    #[test]
    fn a_player_may_move_only_their_own_token() {
        let mut state = room();
        let _rx = join_as_player(&mut state, ClientId(1), "vex");
        let client = state.clients.get(&ClientId(1)).expect("joined");

        let own = state.tokens.get(&TokenId::new("t2")).expect("Vex's token");
        let other_player = state.tokens.get(&TokenId::new("t1")).expect("Grog's token");
        let monster = state
            .tokens
            .get(&TokenId::new("t6"))
            .expect("the DM's ogre");

        assert!(can_move(client, own));
        assert!(!can_move(client, other_player));
        assert!(!can_move(client, monster));
    }

    #[test]
    fn the_dm_may_move_everything() {
        let mut state = room();
        let _rx = join_as_dm(&mut state, ClientId(1));
        let client = state.clients.get(&ClientId(1)).expect("joined");

        for token in state.tokens.values() {
            assert!(can_move(client, token), "DM blocked from {}", token.name);
        }
    }

    #[test]
    fn moving_someone_elses_token_is_refused_by_name() {
        let mut state = room();
        let _rx = join_as_player(&mut state, ClientId(1), "vex");

        let err = state
            .check(
                ClientId(1),
                &ClientMsg::MoveToken {
                    id: TokenId::new("t1"),
                    x: 0.0,
                    y: 0.0,
                    dragging: false,
                    staged: false,
                },
            )
            .expect_err("should be refused");
        assert!(err.contains("Grog"), "error should name the token: {err}");
    }

    #[test]
    fn an_unidentified_client_cannot_move_anything() {
        let mut state = room();
        let _rx = connect(&mut state, ClientId(1));

        assert!(
            state
                .check(
                    ClientId(1),
                    &ClientMsg::MoveToken {
                        id: TokenId::new("t1"),
                        x: 0.0,
                        y: 0.0,
                        dragging: false,
                        staged: false,
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn a_refused_move_changes_nothing_and_tells_nobody() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(1), "vex");
        let mut grog = join_as_player(&mut state, ClientId(2), "grog");

        let before = state.tokens.get(&TokenId::new("t1")).expect("t1").x;
        state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("t1"),
                x: 99.0,
                y: 99.0,
                dragging: false,
                staged: false,
            },
        );

        assert_eq!(state.tokens.get(&TokenId::new("t1")).expect("t1").x, before);
        assert!(grog.try_recv().is_err(), "a refusal must not be broadcast");
    }

    #[test]
    fn identity_cannot_be_changed_after_joining() {
        let mut state = room();
        let mut rx = join_as_player(&mut state, ClientId(1), "vex");

        state.handle(
            ClientId(1),
            ClientMsg::Hello {
                dm_secret: Some(SECRET.to_owned()),
                player_id: None,
            },
        );

        assert!(matches!(rx.try_recv(), Ok(ServerMsg::Error { .. })));
        let client = state.clients.get(&ClientId(1)).expect("still joined");
        assert_eq!(client.identity, Identity::Player(PlayerId::new("vex")));
    }

    // --- movement (unchanged from milestone 2) ------------------------------

    #[test]
    fn drop_frames_snap_and_drag_frames_do_not() {
        let mut state = room();

        let events = state.apply(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("t1"),
                x: 6.83,
                y: 5.21,
                dragging: true,
                staged: false,
            },
        );
        assert!(
            matches!(events.as_slice(), [Event::TokenMoved { x, y, .. }] if *x == 6.83 && *y == 5.21)
        );

        let events = state.apply(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("t1"),
                x: 6.83,
                y: 5.21,
                dragging: false,
                staged: false,
            },
        );
        assert!(
            matches!(events.as_slice(), [Event::TokenMoved { x, y, .. }] if *x == 6.5 && *y == 5.5)
        );

        let token = state.tokens.get(&TokenId::new("t1")).expect("t1 exists");
        assert_eq!((token.x, token.y), (6.5, 5.5));
    }

    #[test]
    fn snapping_is_stable_under_repeated_drops() {
        for size in TOKEN_SIZES {
            let settled = snap_to_cell(6.4, 5.4, size);
            assert_eq!(
                snap_to_cell(settled.0, settled.1, size),
                settled,
                "a {size}-cell token drifted when dropped where it already was"
            );
        }
    }

    #[test]
    fn snapping_handles_negative_coordinates() {
        // A token dragged off the top-left belongs in cell -1, not folded back
        // onto the board. Off-map drags are legal — that is where the DM stages
        // the next wave.
        assert_eq!(snap_to_cell(-0.2, -1.7, 1.0), (-0.5, -1.5));
        assert_eq!(snap_to_cell(-0.2, -1.7, 2.0), (0.0, -2.0));
    }

    #[test]
    fn an_odd_token_settles_on_a_cell_centre_and_an_even_one_on_a_corner() {
        // The whole size-dependent snapping rule, stated once. A 2×2 covering
        // cells (0,0) through (1,1) is centred at (1,1) — the corner those four
        // cells meet at — because it has no middle cell to sit in.
        assert_eq!(snap_to_cell(6.83, 5.21, 1.0), (6.5, 5.5));
        assert_eq!(snap_to_cell(6.83, 5.21, 3.0), (6.5, 5.5));
        assert_eq!(snap_to_cell(6.83, 5.21, 2.0), (7.0, 5.0));
        assert_eq!(snap_to_cell(6.83, 5.21, 4.0), (7.0, 5.0));
    }

    #[test]
    fn shrinking_off_a_corner_picks_one_cell_and_always_the_same_one() {
        // A 2×2 stands on the corner four cells meet at, so shrinking it is a
        // four-way tie. `round` breaks it away from zero — down and right on
        // the board, the other way in the negative space off the top-left of
        // it. Which cell it picks matters far less than picking the same one
        // every time, which is what stops a resize from looking like a jitter.
        assert_eq!(snap_to_cell(9.0, 4.0, 1.0), (9.5, 4.5));
        assert_eq!(snap_to_cell(-9.0, -4.0, 1.0), (-9.5, -4.5));
    }

    #[test]
    fn a_tiny_token_settles_in_the_middle_of_a_square() {
        // Not on a quarter-cell lattice of its own. A druid who is a rat stands
        // in a square with everyone else, just drawn small.
        assert_eq!(snap_to_cell(6.83, 5.21, 0.5), (6.5, 5.5));
    }

    #[test]
    fn originator_is_spared_drag_echoes_but_not_the_drop() {
        let state = room();
        let me = ClientId(1);
        let them = ClientId(2);

        let drag = Event::TokenMoved {
            id: TokenId::new("t1"),
            x: 1.0,
            y: 1.0,
            dragging: true,
            staged: false,
        };
        assert!(state.message_for(me, me, &drag).is_none());
        assert!(state.message_for(them, me, &drag).is_some());

        let drop = Event::TokenMoved {
            id: TokenId::new("t1"),
            x: 1.5,
            y: 1.5,
            dragging: false,
            staged: false,
        };
        assert!(state.message_for(me, me, &drop).is_some());
        assert!(state.message_for(them, me, &drop).is_some());
    }

    #[test]
    fn unknown_tokens_are_refused() {
        let mut state = room();
        let _rx = join_as_dm(&mut state, ClientId(1));
        let msg = ClientMsg::MoveToken {
            id: TokenId::new("nope"),
            x: 0.0,
            y: 0.0,
            dragging: false,
            staged: false,
        };
        assert!(state.check(ClientId(1), &msg).is_err());
    }

    // --- the token lifecycle ------------------------------------------------

    fn create(name: &str, size: f32, owner: Owner) -> ClientMsg {
        ClientMsg::CreateToken {
            name: name.to_owned(),
            img: String::new(),
            size,
            owner,
            x: 6.3,
            y: 5.1,
            hidden: false,
            hp: None,
            staged: false,
        }
    }

    /// The same command with the token already out of sight of the table.
    fn create_hidden(name: &str) -> ClientMsg {
        with(create(name, 1.0, Owner::Dm), |hidden, _| *hidden = true)
    }

    /// The same command again, building the token on the map the DM is
    /// preparing rather than on the board.
    fn create_staged(name: &str) -> ClientMsg {
        with(create(name, 1.0, Owner::Dm), |_, staged| *staged = true)
    }

    /// Flips one or both of the two flags on a `CreateToken`, so the helpers
    /// above stay one line each and a field added later does not have to be
    /// restated in any of them.
    fn with(msg: ClientMsg, set: impl FnOnce(&mut bool, &mut bool)) -> ClientMsg {
        let ClientMsg::CreateToken {
            mut hidden,
            mut staged,
            name,
            img,
            size,
            owner,
            x,
            y,
            hp,
        } = msg
        else {
            return msg;
        };
        set(&mut hidden, &mut staged);
        ClientMsg::CreateToken {
            name,
            img,
            size,
            owner,
            x,
            y,
            hidden,
            hp,
            staged,
        }
    }

    /// An edit that leaves a token exactly as it is. Tests change one field off
    /// this rather than restating all seven, so a field added later does not
    /// silently reset itself everywhere.
    fn edit(token: &Token) -> ClientMsg {
        ClientMsg::UpdateToken {
            id: token.id.clone(),
            name: token.name.clone(),
            img: token.img.clone(),
            size: token.size,
            owner: token.owner.clone(),
            hidden: token.hidden,
            hp: token.hp,
        }
    }

    /// That edit with `hidden` flipped to `want`.
    fn set_hidden(token: &Token, want: bool) -> ClientMsg {
        match edit(token) {
            ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                owner,
                hp,
                ..
            } => ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                owner,
                hidden: want,
                hp,
            },
            other => other,
        }
    }

    fn token(state: &RoomState, id: &str) -> Token {
        state
            .tokens
            .get(&TokenId::new(id))
            .unwrap_or_else(|| panic!("no token {id}"))
            .clone()
    }

    /// The token the DM just made, found by name because the id is the server's.
    ///
    /// Names must therefore be unique within a test, and must not collide with
    /// the built-in room's — `HashMap` order is unspecified, so a duplicate
    /// name is a test that passes or fails depending on the run.
    fn made(state: &RoomState, name: &str) -> Token {
        let mut found = state.tokens.values().filter(|t| t.name == name);
        let token = found
            .next()
            .unwrap_or_else(|| panic!("no token called {name}"))
            .clone();
        assert!(
            found.next().is_none(),
            "two tokens called {name}; this test cannot tell them apart"
        );
        token
    }

    #[test]
    fn the_dm_can_build_a_token_and_the_server_names_it() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let before = state.tokens.len();

        assert!(
            state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm)),
            "a new token is worth saving"
        );

        assert_eq!(state.tokens.len(), before + 1);
        let goblin = made(&state, "Goblin");
        assert!(
            !goblin.id.0.is_empty() && !state.tokens.contains_key(&TokenId::new("t1_")),
            "the id comes from the server, not the client"
        );
        assert_eq!((goblin.x, goblin.y), (6.5, 5.5), "it lands on the grid");
        assert_eq!(goblin.size, 1.0);
    }

    #[test]
    fn two_tokens_built_the_same_way_are_still_two_tokens() {
        // The id is invented per command, so a DM clicking twice gets a pair
        // rather than overwriting the first.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm));
        state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm));

        let goblins = state.tokens.values().filter(|t| t.name == "Goblin").count();
        assert_eq!(goblins, 2);
    }

    #[test]
    fn a_new_token_lands_on_the_lattice_its_size_belongs_to() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        // Not "Ogre": the built-in room already has one, and `made` matches by
        // name. Created at (6.3, 5.1) by `create`.
        state.handle(ClientId(1), create("Dire Wolf", 2.0, Owner::Dm));

        let wolf = made(&state, "Dire Wolf");
        assert_eq!(
            (wolf.x, wolf.y),
            (6.0, 5.0),
            "an even-sized token settles on a cell corner"
        );
    }

    #[test]
    fn resizing_a_token_moves_it_onto_the_right_lattice() {
        // The reason `UpdateToken` re-snaps. Left where it stood, a 2×2 grown
        // from a 1×1 would straddle half a cell in both directions until the
        // next time somebody happened to drag it.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6").clone();
        assert_eq!((ogre.x, ogre.y), (14.5, 9.5));

        state.handle(
            ClientId(1),
            ClientMsg::UpdateToken {
                id: ogre.id.clone(),
                name: ogre.name.clone(),
                img: ogre.img.clone(),
                size: 2.0,
                owner: Owner::Dm,
                hidden: false,
                hp: None,
            },
        );

        let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6");
        assert_eq!((ogre.x, ogre.y), (15.0, 10.0));
    }

    #[test]
    fn an_edit_that_leaves_the_size_alone_leaves_the_position_alone() {
        // Renaming a token mid-drag must not teleport it: `MoveToken` owns the
        // position, and an unsnapped drag frame is a legitimate state to be in.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("t6"),
                x: 3.27,
                y: 8.11,
                dragging: true,
                staged: false,
            },
        );

        state.handle(
            ClientId(1),
            ClientMsg::UpdateToken {
                id: TokenId::new("t6"),
                name: "Ogre (bloodied)".to_owned(),
                img: "/uploads/ogre.png".to_owned(),
                size: 1.0,
                owner: Owner::Dm,
                hidden: false,
                hp: None,
            },
        );

        let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6");
        assert_eq!((ogre.x, ogre.y), (3.27, 8.11));
        assert_eq!(ogre.name, "Ogre (bloodied)");
    }

    #[test]
    fn handing_a_token_to_a_player_lets_them_move_it_and_taking_it_back_does_not() {
        // The wild shape story end to end: the DM builds a big cat, gives it to
        // Vex, and takes it back when the spell ends.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let _vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(ClientId(1), create("Dire Wolf", 2.0, Owner::Dm));
        let wolf = made(&state, "Dire Wolf");

        let vex = state.clients.get(&ClientId(2)).expect("joined");
        assert!(!can_move(vex, &wolf), "it starts as the DM's");

        let hand_to = |owner: Owner| ClientMsg::UpdateToken {
            id: wolf.id.clone(),
            name: wolf.name.clone(),
            img: wolf.img.clone(),
            size: wolf.size,
            owner,
            hidden: false,
            hp: None,
        };

        state.handle(ClientId(1), hand_to(Owner::Player(PlayerId::new("vex"))));
        let vex = state.clients.get(&ClientId(2)).expect("joined");
        assert!(can_move(vex, &made(&state, "Dire Wolf")));

        state.handle(ClientId(1), hand_to(Owner::Dm));
        let vex = state.clients.get(&ClientId(2)).expect("joined");
        assert!(!can_move(vex, &made(&state, "Dire Wolf")));
    }

    #[test]
    fn a_player_cannot_touch_the_lifecycle_at_all() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(1), "vex");
        let _dm = join_as_dm(&mut state, ClientId(2));

        // Including their own token: reassigning `owner` is how a token is given
        // away, so a player who could edit theirs could take anyone's.
        let commands = || {
            vec![
                create("Goblin", 1.0, Owner::Dm),
                ClientMsg::UpdateToken {
                    id: TokenId::new("t2"),
                    name: "Vex".to_owned(),
                    img: String::new(),
                    size: 4.0,
                    owner: Owner::Player(PlayerId::new("vex")),
                    hidden: false,
                    hp: None,
                },
                ClientMsg::DeleteToken {
                    id: TokenId::new("t1"),
                },
            ]
        };

        for cmd in commands() {
            assert!(
                state.check(ClientId(1), &cmd).is_err(),
                "a player got through: {cmd:?}"
            );
        }
        for cmd in commands() {
            assert!(
                state.check(ClientId(2), &cmd).is_ok(),
                "the DM was blocked: {cmd:?}"
            );
        }
    }

    #[test]
    fn a_players_refused_edit_changes_nothing() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(1), "vex");

        state.handle(
            ClientId(1),
            ClientMsg::UpdateToken {
                id: TokenId::new("t6"),
                name: "Mine Now".to_owned(),
                img: String::new(),
                size: 4.0,
                owner: Owner::Player(PlayerId::new("vex")),
                hidden: false,
                hp: None,
            },
        );

        let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6");
        assert_eq!(ogre.name, "Ogre");
        assert_eq!(ogre.owner, Owner::Dm);
        assert_eq!(ogre.size, 1.0);
    }

    #[test]
    fn deleting_a_token_takes_its_initiative_row_with_it() {
        // Otherwise the order holds a row naming a token that no longer exists,
        // which the panel draws as a bare id and `next_turn` hands the turn to.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for (token, value) in [("t1", 20), ("t6", 15), ("t7", 10)] {
            state.handle(
                ClientId(1),
                ClientMsg::SetInitiative {
                    token: TokenId::new(token),
                    value,
                },
            );
        }
        state.handle(ClientId(1), ClientMsg::NextTurn);
        state.handle(ClientId(1), ClientMsg::NextTurn);
        assert_eq!(current(&state.initiative), Some("t6"));

        state.handle(
            ClientId(1),
            ClientMsg::DeleteToken {
                id: TokenId::new("t6"),
            },
        );

        assert!(!state.tokens.contains_key(&TokenId::new("t6")));
        assert_eq!(order(&state.initiative), ["t1", "t7"]);
        assert_eq!(
            current(&state.initiative),
            Some("t7"),
            "the turn passes to whoever slid into that slot"
        );
    }

    #[test]
    fn deleting_a_token_that_was_not_in_the_order_says_nothing_about_initiative() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new("t1"),
                value: 20,
            },
        );

        let events = state.apply(
            ClientId(1),
            ClientMsg::DeleteToken {
                id: TokenId::new("t6"),
            },
        );

        assert!(
            matches!(events.as_slice(), [Event::TokenRemoved { .. }]),
            "an untouched initiative panel should not be rebuilt: {events:?}"
        );
    }

    #[test]
    fn a_token_that_does_not_exist_cannot_be_edited_or_deleted() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        assert!(
            state
                .check(
                    ClientId(1),
                    &ClientMsg::DeleteToken {
                        id: TokenId::new("ghost")
                    }
                )
                .is_err()
        );
        assert!(
            state
                .check(
                    ClientId(1),
                    &ClientMsg::UpdateToken {
                        id: TokenId::new("ghost"),
                        name: "Ghost".to_owned(),
                        img: String::new(),
                        size: 1.0,
                        owner: Owner::Dm,
                        hidden: false,
                        hp: None,
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn only_the_five_sizes_are_accepted() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for size in TOKEN_SIZES {
            assert!(
                state
                    .check(ClientId(1), &create("Goblin", size, Owner::Dm))
                    .is_ok(),
                "{size} should be fine"
            );
        }
        for size in [0.0, -1.0, 0.25, 1.5, 5.0, 1e9, f32::NAN, f32::INFINITY] {
            assert!(
                state
                    .check(ClientId(1), &create("Goblin", size, Owner::Dm))
                    .is_err(),
                "{size} should be refused"
            );
        }
    }

    #[test]
    fn a_token_needs_a_name_and_cannot_have_an_essay() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for bad in ["", "   ", "\t"] {
            assert!(
                state
                    .check(ClientId(1), &create(bad, 1.0, Owner::Dm))
                    .is_err(),
                "{bad:?} should be refused"
            );
        }
        assert!(
            state
                .check(
                    ClientId(1),
                    &create(&"a".repeat(MAX_TOKEN_NAME_LEN + 1), 1.0, Owner::Dm)
                )
                .is_err()
        );
    }

    #[test]
    fn a_name_is_stored_trimmed() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), create("  Goblin  ", 1.0, Owner::Dm));
        assert_eq!(made(&state, "Goblin").name, "Goblin");
    }

    #[test]
    fn token_art_has_to_live_on_this_server() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        let with_img = |img: &str| ClientMsg::CreateToken {
            name: "Goblin".to_owned(),
            img: img.to_owned(),
            size: 1.0,
            owner: Owner::Dm,
            x: 0.0,
            y: 0.0,
            hidden: false,
            hp: None,
            staged: false,
        };

        for good in ["", "/uploads/abc.png", "/assets/tokens/ogre.png"] {
            assert!(
                state.check(ClientId(1), &with_img(good)).is_ok(),
                "{good:?} should be fine"
            );
        }
        for bad in [
            "https://example.com/goblin.png",
            "//example.com/goblin.png", // protocol-relative, so still off-site
            "uploads/abc.png",
            "data:image/png;base64,AAAA",
        ] {
            assert!(
                state.check(ClientId(1), &with_img(bad)).is_err(),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn a_room_cannot_be_filled_with_tokens_without_limit() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        // `apply` rather than `handle`: the cap being tested lives in `check`,
        // and filling the room through the whole pipeline would only fill this
        // test's outbound mailbox and get the DM dropped as a wedged client.
        for _ in state.tokens.len()..MAX_TOKENS {
            state.apply(ClientId(1), create("Goblin", 1.0, Owner::Dm));
        }

        assert_eq!(state.tokens.len(), MAX_TOKENS);
        assert!(
            state
                .check(ClientId(1), &create("Goblin", 1.0, Owner::Dm))
                .is_err()
        );
    }

    #[test]
    fn a_created_token_reaches_the_dm_who_made_it() {
        // There is no local prediction to rubber-band — the client cannot know
        // the id — so this echo is how the DM's panel learns what it just built.
        let mut state = room();
        let mut dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm));

        for (who, rx) in [("the DM", &mut dm), ("a player", &mut vex)] {
            match rx.try_recv() {
                Ok(ServerMsg::TokenChanged { token }) => assert_eq!(token.name, "Goblin"),
                other => panic!("{who} should have been told: {other:?}"),
            }
        }
    }

    #[test]
    fn a_deleted_token_reaches_everyone() {
        let mut state = room();
        let mut dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(
            ClientId(1),
            ClientMsg::DeleteToken {
                id: TokenId::new("t6"),
            },
        );

        for (who, rx) in [("the DM", &mut dm), ("a player", &mut vex)] {
            match rx.try_recv() {
                Ok(ServerMsg::TokenRemoved { id }) => assert_eq!(id, TokenId::new("t6")),
                other => panic!("{who} should have been told: {other:?}"),
            }
        }
    }

    #[test]
    fn a_new_token_survives_the_save_file() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), create("Dire Wolf", 2.0, Owner::Dm));

        let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
        let saved: Saved = serde_json::from_slice(&json).expect("decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());

        let wolf = made(&restored, "Dire Wolf");
        assert_eq!(wolf.size, 2.0);
        assert_eq!((wolf.x, wolf.y), (6.0, 5.0));
    }

    // --- hidden tokens and hit points ---------------------------------------

    fn as_player(slot: &str) -> Identity {
        Identity::Player(PlayerId::new(slot))
    }

    /// Every frame waiting on a connection. `try_recv` one at a time makes a
    /// test that says "and nothing else" hard to write and easy to get wrong.
    fn drain(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<ServerMsg> {
        let mut frames = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            frames.push(msg);
        }
        frames
    }

    fn names(view: &RoomView) -> Vec<&str> {
        view.tokens.iter().map(|t| t.name.as_str()).collect()
    }

    #[test]
    fn a_hidden_token_is_absent_from_a_players_snapshot_and_present_in_the_dms() {
        // Invariant 3: the join snapshot narrows the same way a delta does. The
        // classic way this leaks is to filter deltas correctly and then hand
        // over the whole world on connect.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), create_hidden("Ambusher"));

        let theirs = state.snapshot_for(&as_player("vex"));
        let ours = state.snapshot_for(&Identity::Dm);

        assert!(!names(&theirs).contains(&"Ambusher"));
        assert!(names(&ours).contains(&"Ambusher"));
        assert_eq!(
            theirs.tokens.len() + 1,
            ours.tokens.len(),
            "only the hidden one should have gone"
        );
    }

    #[test]
    fn a_hidden_monster_is_nowhere_in_the_json_a_player_is_sent() {
        // Invariant 4 the way it actually has to be checked: not "the client
        // does not draw it" but "the bytes are not there to be found".
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            match create_hidden("Ambusher") {
                ClientMsg::CreateToken {
                    name,
                    img,
                    size,
                    owner,
                    x,
                    y,
                    hidden,
                    staged,
                    ..
                } => ClientMsg::CreateToken {
                    name,
                    img,
                    size,
                    owner,
                    x,
                    y,
                    hidden,
                    hp: Some(Hp {
                        current: 4242,
                        max: 4242,
                    }),
                    staged,
                },
                other => other,
            },
        );

        let json = serde_json::to_string(&state.snapshot_for(&as_player("vex"))).expect("encodes");
        assert!(!json.contains("Ambusher"), "the name reached the table");
        assert!(!json.contains("4242"), "the hit points reached the table");
    }

    #[test]
    fn hiding_a_token_takes_it_off_the_table_and_leaves_it_on_the_dms_board() {
        // The one event, two messages case the split between `Event` and
        // `ServerMsg` exists for.
        let mut state = room();
        let mut dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

        match drain(&mut vex).as_slice() {
            [ServerMsg::TokenRemoved { id }] => assert_eq!(id, &TokenId::new("t6")),
            other => panic!("the table should have been told it is gone: {other:?}"),
        }
        match drain(&mut dm).as_slice() {
            [ServerMsg::TokenChanged { token }] => {
                assert!(token.hidden, "the DM keeps it, marked");
            }
            other => panic!("the DM should still have it: {other:?}"),
        }
    }

    #[test]
    fn editing_an_already_hidden_token_tells_the_table_nothing() {
        // A `TokenRemoved` naming an id the players never held would tell them a
        // token exists — which is the entire thing being withheld.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        let ogre = token(&state, "t6");
        state.handle(
            ClientId(1),
            match edit(&ogre) {
                ClientMsg::UpdateToken {
                    id,
                    img,
                    size,
                    owner,
                    hidden,
                    hp,
                    ..
                } => ClientMsg::UpdateToken {
                    id,
                    name: "Ogre (bloodied)".to_owned(),
                    img,
                    size,
                    owner,
                    hidden,
                    hp,
                },
                other => other,
            },
        );

        assert!(
            drain(&mut vex).is_empty(),
            "a token they were never told about has no news"
        );
    }

    #[test]
    fn a_token_created_hidden_is_never_announced() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(ClientId(1), create_hidden("Ambusher"));

        assert!(drain(&mut vex).is_empty());
        assert!(made(&state, "Ambusher").hidden);
    }

    #[test]
    fn unhiding_a_token_is_a_creation_as_far_as_the_table_is_concerned() {
        // The ambush springs. `TokenChanged` for an id the client has not seen
        // is the creation, which is why one message covers both.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), create_hidden("Ambusher"));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(ClientId(1), set_hidden(&made(&state, "Ambusher"), false));

        match drain(&mut vex).as_slice() {
            [ServerMsg::TokenChanged { token }] => assert_eq!(token.name, "Ambusher"),
            other => panic!("the table should meet it now: {other:?}"),
        }
    }

    #[test]
    fn a_hidden_tokens_movement_is_not_relayed_to_the_table() {
        // Thirty frames a second of position would trace an invisible monster's
        // path across the board even with the token itself withheld.
        let mut state = room();
        let mut dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        for dragging in [true, false] {
            state.handle(
                ClientId(1),
                ClientMsg::MoveToken {
                    id: TokenId::new("t6"),
                    x: 2.4,
                    y: 8.1,
                    dragging,
                    staged: false,
                },
            );
        }

        assert!(drain(&mut vex).is_empty(), "the table watched it move");
        assert!(
            drain(&mut dm)
                .iter()
                .any(|m| matches!(m, ServerMsg::TokenMoved { .. })),
            "the DM still needs the settled position"
        );
    }

    #[test]
    fn deleting_a_hidden_token_tells_the_table_nothing() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(
            ClientId(1),
            ClientMsg::DeleteToken {
                id: TokenId::new("t6"),
            },
        );

        assert!(!state.tokens.contains_key(&TokenId::new("t6")));
        assert!(drain(&mut vex).is_empty());
    }

    #[test]
    fn hit_points_reach_the_dm_and_nobody_else() {
        // The per-field redaction this milestone exists to invent: the token is
        // one the table can see, and one field of it is not theirs.
        let mut state = room();
        let mut dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        let ogre = token(&state, "t6");
        state.handle(
            ClientId(1),
            match edit(&ogre) {
                ClientMsg::UpdateToken {
                    id,
                    name,
                    img,
                    size,
                    owner,
                    hidden,
                    ..
                } => ClientMsg::UpdateToken {
                    id,
                    name,
                    img,
                    size,
                    owner,
                    hidden,
                    hp: Some(Hp {
                        current: 22,
                        max: 59,
                    }),
                },
                other => other,
            },
        );

        let hp_of = |frames: &[ServerMsg]| match frames {
            [ServerMsg::TokenChanged { token }] => token.hp,
            other => panic!("expected one TokenChanged, got {other:?}"),
        };
        assert_eq!(
            hp_of(&drain(&mut dm)),
            Some(Hp {
                current: 22,
                max: 59
            })
        );
        assert_eq!(
            hp_of(&drain(&mut vex)),
            None,
            "hit points are the DM's note"
        );

        // And on the snapshot too, by the same route rather than a second one.
        let ogre_in = |view: &RoomView| {
            view.tokens
                .iter()
                .find(|t| t.name == "Ogre")
                .expect("the ogre")
                .hp
        };
        assert!(ogre_in(&state.snapshot_for(&Identity::Dm)).is_some());
        assert_eq!(ogre_in(&state.snapshot_for(&as_player("vex"))), None);
    }

    #[test]
    fn hit_points_are_bounded() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let ogre = token(&state, "t6");

        let with_hp = |hp: Option<Hp>| match edit(&ogre) {
            ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                owner,
                hidden,
                ..
            } => ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                owner,
                hidden,
                hp,
            },
            other => other,
        };

        for good in [
            None,
            Some(Hp { current: 0, max: 0 }),
            // Below zero is bookkeeping, and above `max` is the DM's business:
            // what a hit point *means* is the rules knowledge this does not have.
            Some(Hp {
                current: -7,
                max: 40,
            }),
            Some(Hp {
                current: 12,
                max: 4,
            }),
            Some(Hp {
                current: MAX_HP,
                max: MAX_HP,
            }),
        ] {
            assert!(
                state.check(ClientId(1), &with_hp(good)).is_ok(),
                "{good:?} should be fine"
            );
        }
        for bad in [
            Some(Hp {
                current: MAX_HP + 1,
                max: 10,
            }),
            Some(Hp {
                current: 10,
                max: -MAX_HP - 1,
            }),
        ] {
            assert!(
                state.check(ClientId(1), &with_hp(bad)).is_err(),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn a_hidden_creatures_row_is_not_on_the_tables_initiative_panel() {
        // Otherwise the panel that is always on screen names the one thing the
        // DM just took off the board — and names it with a bare id, because the
        // client has no token to look the name up on.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        for (id, value) in [("t1", 20), ("t6", 15), ("t7", 10)] {
            state.handle(
                ClientId(1),
                ClientMsg::SetInitiative {
                    token: TokenId::new(id),
                    value,
                },
            );
        }
        state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

        assert_eq!(order(&state.initiative_for(true)), ["t1", "t6", "t7"]);
        assert_eq!(order(&state.initiative_for(false)), ["t1", "t7"]);
        assert_eq!(
            state.initiative_for(false).round,
            state.initiative.round,
            "the round is not a secret"
        );
    }

    #[test]
    fn the_turn_is_withheld_while_it_belongs_to_something_hidden() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new("t6"),
                value: 15,
            },
        );
        state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));
        state.handle(ClientId(1), ClientMsg::NextTurn);

        assert_eq!(current(&state.initiative_for(true)), Some("t6"));
        assert_eq!(
            current(&state.initiative_for(false)),
            None,
            "a token id is data, even when it is only the turn marker"
        );
    }

    #[test]
    fn hiding_a_creature_that_is_in_the_order_rebuilds_the_tables_panel() {
        // The panel is not otherwise rebuilt by a token edit, so without this
        // the table keeps a row naming a token their client has just forgotten.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new("t6"),
                value: 15,
            },
        );
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

        match drain(&mut vex).as_slice() {
            [
                ServerMsg::TokenRemoved { .. },
                ServerMsg::InitiativeChanged { initiative },
            ] => {
                assert!(initiative.entries.is_empty(), "the row should have gone");
            }
            other => panic!("expected the token and the row to go together: {other:?}"),
        }
    }

    #[test]
    fn an_edit_that_leaves_hidden_alone_does_not_rebuild_the_panel() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new("t6"),
                value: 15,
            },
        );

        let events = state.apply(ClientId(1), edit(&token(&state, "t6")));

        assert!(
            matches!(events.as_slice(), [Event::TokenChanged { .. }]),
            "an untouched initiative panel should not be rebuilt: {events:?}"
        );
    }

    #[test]
    fn a_hidden_token_and_its_hit_points_survive_the_save_file() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), create_hidden("Ambusher"));

        let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
        let saved: Saved = serde_json::from_slice(&json).expect("decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());

        assert!(
            made(&restored, "Ambusher").hidden,
            "an ambush set up last week is still set up tonight"
        );
    }

    // --- initiative ---------------------------------------------------------

    fn order(init: &Initiative) -> Vec<&str> {
        init.entries.iter().map(|e| e.token.0.as_str()).collect()
    }

    fn current(init: &Initiative) -> Option<&str> {
        init.current.as_ref().map(|t| t.0.as_str())
    }

    /// Builds an order without starting combat, as the DM typing values would.
    fn rolled(pairs: &[(&str, i32)]) -> Initiative {
        let mut init = Initiative::default();
        for (token, value) in pairs {
            init.set(TokenId::new(token), *value);
        }
        init
    }

    /// Builds an order and starts combat, leaving the top entry acting.
    fn in_combat(pairs: &[(&str, i32)]) -> Initiative {
        let mut init = rolled(pairs);
        init.next_turn();
        init
    }

    #[test]
    fn entries_sort_by_value_descending() {
        let init = rolled(&[("t1", 12), ("t2", 20), ("t3", 7)]);
        assert_eq!(order(&init), ["t2", "t1", "t3"]);
    }

    #[test]
    fn ties_keep_the_order_the_dm_entered_them() {
        let init = rolled(&[("t1", 14), ("t2", 14), ("t3", 14)]);
        assert_eq!(order(&init), ["t1", "t2", "t3"]);
    }

    #[test]
    fn building_the_order_does_not_start_combat() {
        // The DM types values in the order the table calls them out, so the
        // first one entered says nothing about who acts first.
        let init = rolled(&[("t1", 12), ("t2", 19), ("t3", 12)]);
        assert_eq!(order(&init), ["t2", "t1", "t3"]);
        assert_eq!(
            current(&init),
            None,
            "nobody acts until the DM starts combat"
        );
    }

    #[test]
    fn combat_starts_at_the_top_of_the_order_whatever_order_it_was_typed_in() {
        let mut init = rolled(&[("t1", 12), ("t2", 19), ("t3", 12)]);
        init.next_turn();
        assert_eq!(current(&init), Some("t2"), "highest roll acts first");
        assert_eq!(init.round, 1, "starting combat is not an extra round");
    }

    #[test]
    fn a_latecomer_never_steals_the_turn() {
        let mut init = in_combat(&[("t1", 20)]);
        assert_eq!(current(&init), Some("t1"));

        // Someone joining mid-fight sorts above the acting creature but must
        // not seize the turn from it.
        init.set(TokenId::new("t2"), 25);
        assert_eq!(order(&init), ["t2", "t1"]);
        assert_eq!(current(&init), Some("t1"));
    }

    #[test]
    fn re_valuing_an_entry_resorts_without_moving_the_turn() {
        let mut init = in_combat(&[("t1", 20), ("t2", 15), ("t3", 10)]);
        init.next_turn();
        assert_eq!(current(&init), Some("t2"));

        // The whole reason the current turn is tracked by token and not by list
        // index: this re-sort shifts t2 from position 1 to position 2.
        init.set(TokenId::new("t3"), 25);
        assert_eq!(order(&init), ["t3", "t1", "t2"]);
        assert_eq!(
            current(&init),
            Some("t2"),
            "the turn must not follow the index"
        );
    }

    #[test]
    fn setting_an_existing_token_revalues_rather_than_duplicating() {
        let mut init = rolled(&[("t1", 20), ("t2", 15)]);
        init.set(TokenId::new("t2"), 30);
        assert_eq!(init.entries.len(), 2);
        assert_eq!(order(&init), ["t2", "t1"]);
    }

    #[test]
    fn turns_advance_and_wrap_into_the_next_round() {
        let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
        assert_eq!((current(&init), init.round), (Some("t1"), 1));

        init.next_turn();
        assert_eq!((current(&init), init.round), (Some("t2"), 1));

        init.next_turn();
        assert_eq!(
            (current(&init), init.round),
            (Some("t1"), 2),
            "wrapping starts a new round"
        );
    }

    #[test]
    fn turns_reverse_and_wrap_back_a_round() {
        let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
        init.next_turn();
        init.next_turn();
        assert_eq!((current(&init), init.round), (Some("t1"), 2));

        init.previous_turn();
        assert_eq!((current(&init), init.round), (Some("t2"), 1));
    }

    #[test]
    fn reversing_past_the_start_of_combat_does_nothing() {
        let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
        init.previous_turn();
        assert_eq!(
            (current(&init), init.round),
            (Some("t1"), 1),
            "there is no round 0"
        );
    }

    #[test]
    fn reversing_before_combat_starts_does_nothing() {
        let mut init = rolled(&[("t1", 20), ("t2", 15)]);
        init.previous_turn();
        assert_eq!((current(&init), init.round), (None, 1));
    }

    #[test]
    fn removing_the_active_entry_hands_the_turn_to_the_next() {
        let mut init = in_combat(&[("t1", 20), ("t2", 15), ("t3", 10)]);
        init.next_turn();
        assert_eq!(current(&init), Some("t2"));

        init.remove(&TokenId::new("t2"));
        assert_eq!(order(&init), ["t1", "t3"]);
        assert_eq!(current(&init), Some("t3"));
    }

    #[test]
    fn removing_an_inactive_entry_leaves_the_turn_alone() {
        let mut init = in_combat(&[("t1", 20), ("t2", 15), ("t3", 10)]);
        init.next_turn();
        init.remove(&TokenId::new("t3"));
        assert_eq!(current(&init), Some("t2"));
    }

    #[test]
    fn emptying_the_list_leaves_nobody_acting() {
        let mut init = in_combat(&[("t1", 20)]);
        init.remove(&TokenId::new("t1"));
        assert!(init.entries.is_empty());
        assert_eq!(current(&init), None);
    }

    #[test]
    fn advancing_an_empty_list_is_a_no_op() {
        let mut init = Initiative::default();
        init.next_turn();
        init.previous_turn();
        assert_eq!((current(&init), init.round), (None, 1));
    }

    #[test]
    fn clearing_resets_the_round_counter() {
        let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
        init.next_turn();
        init.next_turn();
        assert_eq!(init.round, 2);

        init.clear();
        assert_eq!(
            (current(&init), init.round, init.entries.len()),
            (None, 1, 0)
        );
    }

    #[test]
    fn only_the_dm_may_touch_initiative() {
        let mut state = room();
        let _player = join_as_player(&mut state, ClientId(1), "vex");
        let _dm = join_as_dm(&mut state, ClientId(2));

        let commands = || {
            vec![
                ClientMsg::SetInitiative {
                    token: TokenId::new("t1"),
                    value: 15,
                },
                ClientMsg::RemoveFromInitiative {
                    token: TokenId::new("t1"),
                },
                ClientMsg::ClearInitiative,
                ClientMsg::NextTurn,
                ClientMsg::PreviousTurn,
            ]
        };

        for cmd in commands() {
            assert!(
                state.check(ClientId(1), &cmd).is_err(),
                "a player got through: {cmd:?}"
            );
        }
        for cmd in commands() {
            assert!(
                state.check(ClientId(2), &cmd).is_ok(),
                "the DM was blocked: {cmd:?}"
            );
        }
    }

    #[test]
    fn initiative_cannot_name_a_token_that_does_not_exist() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let cmd = ClientMsg::SetInitiative {
            token: TokenId::new("ghost"),
            value: 10,
        };
        assert!(state.check(ClientId(1), &cmd).is_err());
    }

    #[test]
    fn a_players_refused_initiative_edit_changes_nothing() {
        let mut state = room();
        let _player = join_as_player(&mut state, ClientId(1), "vex");
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new("t1"),
                value: 99,
            },
        );
        assert!(state.initiative.entries.is_empty());
    }

    // --- roster claims ------------------------------------------------------

    #[test]
    fn occupied_slots_are_reported_as_claimed() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(1), "vex");

        let slots = state.roster_slots();
        let claimed: Vec<_> = slots
            .iter()
            .filter(|s| s.claimed)
            .map(|s| s.id.0.as_str())
            .collect();
        assert_eq!(claimed, ["vex"]);
        assert_eq!(
            slots.len(),
            5,
            "every slot is still offered — claiming is advisory"
        );
    }

    #[test]
    fn a_slot_frees_up_when_its_client_disconnects() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(1), "vex");
        state.clients.remove(&ClientId(1));

        assert!(state.roster_slots().iter().all(|s| !s.claimed));
    }

    #[test]
    fn the_dm_occupies_no_slot() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        assert!(state.roster_slots().iter().all(|s| !s.claimed));
    }

    #[test]
    fn anyone_still_picking_is_told_when_a_slot_is_taken() {
        let mut state = room();
        let mut watcher = connect(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            ClientMsg::Hello {
                dm_secret: None,
                player_id: None,
            },
        );
        watcher.try_recv().expect("the initial roster");

        let _vex = join_as_player(&mut state, ClientId(2), "vex");

        match watcher.try_recv().expect("an updated roster") {
            ServerMsg::ChooseIdentity { roster } => {
                let vex = roster.iter().find(|s| s.id.0 == "vex").expect("vex");
                assert!(vex.claimed, "the open picker should have been refreshed");
            }
            other => panic!("expected ChooseIdentity, got {other:?}"),
        }
    }

    // --- the map ------------------------------------------------------------

    fn set_map(url: &str, grid_px: f32, offset_x: f32, offset_y: f32) -> ClientMsg {
        ClientMsg::SetMap {
            url: url.to_owned(),
            grid_px,
            offset_x,
            offset_y,
            grid_color: "#ffffff52".to_owned(),
            play_area: None,
            staged: false,
        }
    }

    fn set_color(color: &str) -> ClientMsg {
        ClientMsg::SetMap {
            url: "/assets/map.png".to_owned(),
            grid_px: 64.0,
            offset_x: 0.0,
            offset_y: 0.0,
            grid_color: color.to_owned(),
            play_area: None,
            staged: false,
        }
    }

    fn set_area(area: Option<Rect>) -> ClientMsg {
        ClientMsg::SetMap {
            url: "/assets/map.png".to_owned(),
            grid_px: 64.0,
            offset_x: 0.0,
            offset_y: 0.0,
            grid_color: "#ffffff52".to_owned(),
            play_area: area,
            staged: false,
        }
    }

    /// The same command aimed at the staged slot. Every map helper here builds a
    /// live `set_map`; this is how a test asks for the staged one, so the two
    /// slots are always exercised with identical commands.
    fn staged(msg: ClientMsg) -> ClientMsg {
        match msg {
            ClientMsg::SetMap {
                url,
                grid_px,
                offset_x,
                offset_y,
                grid_color,
                play_area,
                staged: _,
            } => ClientMsg::SetMap {
                url,
                grid_px,
                offset_x,
                offset_y,
                grid_color,
                play_area,
                staged: true,
            },
            other => other,
        }
    }

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Option<Rect> {
        Some(Rect { x, y, w, h })
    }

    #[test]
    fn only_the_dm_may_change_the_map() {
        let mut state = room();
        let _player = join_as_player(&mut state, ClientId(1), "vex");
        let _dm = join_as_dm(&mut state, ClientId(2));

        assert!(
            state
                .check(ClientId(1), &set_map("/uploads/a.png", 70.0, 3.0, 4.0))
                .is_err()
        );
        assert!(
            state
                .check(ClientId(2), &set_map("/uploads/a.png", 70.0, 3.0, 4.0))
                .is_ok()
        );
    }

    #[test]
    fn recalibrating_the_grid_does_not_move_a_single_token() {
        // Invariant 1, stated as a test. Positions are grid units, so a token
        // stays in the cell it was in however the grid is redefined underneath
        // it — this is the entire reason pixels are not stored.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let before: Vec<(TokenId, f32, f32)> = state
            .tokens
            .values()
            .map(|t| (t.id.clone(), t.x, t.y))
            .collect();

        state.handle(ClientId(1), set_map("/assets/map.png", 97.5, 13.0, -21.0));

        for (id, x, y) in before {
            let token = state.tokens.get(&id).expect("token survived");
            assert_eq!((token.x, token.y), (x, y), "{} moved", token.name);
        }
    }

    #[test]
    fn a_new_map_replaces_every_field() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 12.5, 6.25));

        let map = &state.map;
        assert_eq!(map.url, "/uploads/cave.webp");
        assert_eq!(
            (map.grid_px, map.offset_x, map.offset_y),
            (70.0, 12.5, 6.25)
        );
    }

    // --- remembered calibration ----------------------------------------------

    /// A `set_map` with every calibrated field distinct, so a test can tell
    /// which of two calibrations came back.
    fn calibrate(url: &str, grid_px: f32, offset: f32, color: &str) -> ClientMsg {
        ClientMsg::SetMap {
            url: url.to_owned(),
            grid_px,
            offset_x: offset,
            offset_y: -offset,
            grid_color: color.to_owned(),
            play_area: rect(offset, offset, grid_px * 10.0, grid_px * 8.0),
            staged: false,
        }
    }

    #[test]
    fn re_picking_a_map_comes_back_calibrated() {
        // The whole point of the table: the DM calibrated this map weeks ago and
        // should not have to do it again.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
        );
        state.handle(
            ClientId(1),
            calibrate("/uploads/keep.png", 51.0, 2.0, "#aabbccdd"),
        );
        // Back to the first, with whatever defaults the client happened to send.
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 64.0, 0.0, "#ffffff52"),
        );

        let map = &state.map;
        assert_eq!(map.url, "/uploads/cave.png");
        assert_eq!(map.grid_px, 82.0, "the remembered grid should have won");
        assert_eq!((map.offset_x, map.offset_y), (7.0, -7.0));
        assert_eq!(map.grid_color, "#11223344");
        assert_eq!(map.play_area, rect(7.0, 7.0, 820.0, 656.0));
    }

    #[test]
    fn the_current_map_can_still_be_recalibrated() {
        // The failure this guards against is total: if a remembered calibration
        // also won here, a map could never be corrected once it had been set.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
        );
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 96.0, 3.0, "#99887766"),
        );

        let map = &state.map;
        assert_eq!(map.grid_px, 96.0, "the DM's correction should have stuck");
        assert_eq!((map.offset_x, map.offset_y), (3.0, -3.0));
        assert_eq!(map.grid_color, "#99887766");
    }

    #[test]
    fn a_recalibration_is_what_gets_remembered() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
        );
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 96.0, 3.0, "#99887766"),
        );
        state.handle(
            ClientId(1),
            calibrate("/uploads/keep.png", 51.0, 2.0, "#aabbccdd"),
        );
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 64.0, 0.0, "#ffffff52"),
        );

        assert_eq!(
            state.map.grid_px, 96.0,
            "the corrected calibration should have replaced the first one"
        );
    }

    #[test]
    fn a_map_nobody_has_calibrated_keeps_what_the_client_sent() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            calibrate("/uploads/new.png", 77.0, 5.0, "#12345678"),
        );

        assert_eq!(state.map.grid_px, 77.0);
        assert_eq!(
            state
                .calibrations
                .get("/uploads/new.png")
                .map(|c| c.grid_px),
            Some(77.0),
            "a first sighting is worth remembering too"
        );
    }

    #[test]
    fn a_remembered_calibration_never_reaches_a_client() {
        // It is server-side only. Everything a client needs is already in the
        // `MapInfo` the room sends back.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
        );

        let view = state.snapshot_for(&Identity::Dm);
        let json = serde_json::to_string(&view).expect("serialises");
        assert!(
            !json.contains("calibration"),
            "the table has no business on the wire: {json}"
        );
    }

    #[test]
    fn the_calibration_table_is_saved() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
        );

        let saved = state.to_saved();
        assert_eq!(
            saved
                .calibrations
                .get("/uploads/cave.png")
                .map(|c| c.grid_px),
            Some(82.0)
        );

        // And survives the trip back, which is when it actually matters — the
        // group is not playing between sessions.
        let restored = RoomState::restored(saved, SECRET.to_owned());
        assert_eq!(
            restored
                .calibrations
                .get("/uploads/cave.png")
                .map(|c| c.grid_px),
            Some(82.0)
        );
    }

    #[test]
    fn a_refused_calibration_is_not_remembered() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        // Rejected by `check`, so `apply` never runs and nothing is recorded.
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 0.5, 7.0, "#11223344"),
        );

        assert!(state.calibrations.is_empty());
        assert_ne!(state.map.url, "/uploads/cave.png");
    }

    // --- the staged map -------------------------------------------------------

    /// Stages a map and drains the DM's echo, leaving the receiver empty so a
    /// test can assert on what arrives next.
    fn stage(state: &mut RoomState, dm: ClientId, url: &str) {
        state.handle(dm, staged(set_map(url, 80.0, 0.0, 0.0)));
    }

    #[test]
    fn a_staged_map_is_not_in_a_players_snapshot() {
        // Invariant 4. Not sent-and-not-drawn — absent, so there is nothing in
        // devtools to find.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        stage(&mut state, ClientId(1), "/uploads/next.png");

        let view = state.snapshot_for(&Identity::Player(PlayerId::new("vex")));
        assert!(view.staged.is_none());

        let json = serde_json::to_string(&view).expect("serialises");
        assert!(
            !json.contains("next.png"),
            "the next dungeon leaked into a player's snapshot: {json}"
        );
    }

    #[test]
    fn the_dm_sees_the_staged_map_in_their_snapshot() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        stage(&mut state, ClientId(1), "/uploads/next.png");

        let view = state.snapshot_for(&Identity::Dm);
        assert_eq!(view.staged.map(|m| m.url), Some("/uploads/next.png".into()));
    }

    #[test]
    fn a_staged_map_never_reaches_a_player_as_a_delta() {
        // The other half of invariant 3: filtering the join snapshot is worth
        // nothing if the deltas leak it afterwards.
        let mut state = room();
        let dm = ClientId(1);
        let player = ClientId(2);
        let mut dm_rx = join_as_dm(&mut state, dm);
        let mut player_rx = join_as_player(&mut state, player, "vex");

        stage(&mut state, dm, "/uploads/next.png");

        assert!(
            matches!(dm_rx.try_recv(), Ok(ServerMsg::StagedChanged { map: Some(m) }) if m.url == "/uploads/next.png")
        );
        assert!(
            player_rx.try_recv().is_err(),
            "a player should have been sent nothing at all"
        );
    }

    #[test]
    fn staging_a_map_leaves_the_board_alone() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let before = state.map.url.clone();

        stage(&mut state, ClientId(1), "/uploads/next.png");

        assert_eq!(state.map.url, before, "the table is still on the old map");
        assert_eq!(
            state.staged.as_ref().map(|m| m.grid_px),
            Some(80.0),
            "and the staged slot holds what was sent"
        );
    }

    #[test]
    fn a_player_cannot_stage_promote_or_discard() {
        let mut state = room();
        let _player = join_as_player(&mut state, ClientId(1), "vex");
        let _dm = join_as_dm(&mut state, ClientId(2));
        stage(&mut state, ClientId(2), "/uploads/next.png");

        for msg in [
            staged(set_map("/uploads/theirs.png", 64.0, 0.0, 0.0)),
            ClientMsg::PromoteStaged,
            ClientMsg::ClearStaged,
        ] {
            assert!(
                state.check(ClientId(1), &msg).is_err(),
                "{msg:?} should be DM-only"
            );
            assert!(state.check(ClientId(2), &msg).is_ok());
        }
    }

    #[test]
    fn promoting_puts_the_staged_map_on_the_board_and_empties_the_slot() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        stage(&mut state, ClientId(1), "/uploads/next.png");

        state.handle(ClientId(1), ClientMsg::PromoteStaged);

        assert_eq!(state.map.url, "/uploads/next.png");
        assert_eq!(state.map.grid_px, 80.0, "calibrated while staged");
        assert!(state.staged.is_none(), "one slot, and it has been spent");
    }

    #[test]
    fn promoting_reaches_the_table_but_the_empty_slot_reaches_only_the_dm() {
        let mut state = room();
        let dm = ClientId(1);
        let player = ClientId(2);
        let mut dm_rx = join_as_dm(&mut state, dm);
        let mut player_rx = join_as_player(&mut state, player, "vex");
        stage(&mut state, dm, "/uploads/next.png");
        let _staged_echo = dm_rx.try_recv().expect("the staging echo");

        state.handle(dm, ClientMsg::PromoteStaged);

        assert!(
            matches!(player_rx.try_recv(), Ok(ServerMsg::MapChanged { map }) if map.url == "/uploads/next.png")
        );
        assert!(
            player_rx.try_recv().is_err(),
            "the slot emptying is not a player's business"
        );

        assert!(matches!(dm_rx.try_recv(), Ok(ServerMsg::MapChanged { .. })));
        assert!(matches!(
            dm_rx.try_recv(),
            Ok(ServerMsg::StagedChanged { map: None })
        ));
    }

    #[test]
    fn promoting_does_not_move_a_single_token() {
        // Tokens are stored in cells, so there is nothing sensible to carry them
        // across two unrelated images by. They stay put and the DM repositions.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let before: Vec<(TokenId, f32, f32)> = state
            .tokens
            .values()
            .map(|t| (t.id.clone(), t.x, t.y))
            .collect();

        stage(&mut state, ClientId(1), "/uploads/next.png");
        state.handle(ClientId(1), ClientMsg::PromoteStaged);

        for (id, x, y) in before {
            let token = state.tokens.get(&id).expect("token survived");
            assert_eq!((token.x, token.y), (x, y), "{} moved", token.name);
        }
    }

    #[test]
    fn discarding_empties_the_slot_and_leaves_the_board_alone() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let before = state.map.url.clone();
        stage(&mut state, ClientId(1), "/uploads/next.png");

        state.handle(ClientId(1), ClientMsg::ClearStaged);

        assert!(state.staged.is_none());
        assert_eq!(state.map.url, before);
    }

    #[test]
    fn promoting_or_discarding_nothing_is_refused() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for msg in [ClientMsg::PromoteStaged, ClientMsg::ClearStaged] {
            let refusal = state.check(ClientId(1), &msg).expect_err("nothing staged");
            assert!(refusal.contains("no map staged"), "{refusal}");
        }
    }

    #[test]
    fn a_calibration_made_while_staged_is_remembered() {
        // Which is what makes the promoted map arrive already calibrated, and
        // what makes re-picking it weeks later come back the same.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(
            ClientId(1),
            staged(calibrate("/uploads/next.png", 91.0, 4.0, "#aabbccdd")),
        );

        assert_eq!(
            state
                .calibrations
                .get("/uploads/next.png")
                .map(|c| c.grid_px),
            Some(91.0)
        );

        state.handle(ClientId(1), ClientMsg::PromoteStaged);
        assert_eq!(state.map.grid_px, 91.0);
        assert_eq!(state.map.grid_color, "#aabbccdd");
    }

    #[test]
    fn staging_a_map_calibrated_earlier_comes_back_calibrated() {
        // The staged slot is empty, so this is a load — and a load loses to
        // whatever the room already remembers for that URL.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
        );

        state.handle(
            ClientId(1),
            staged(calibrate("/uploads/cave.png", 64.0, 0.0, "#ffffff52")),
        );

        assert_eq!(
            state.staged.as_ref().map(|m| m.grid_px),
            Some(82.0),
            "the client's opening bid should have lost to the remembered value"
        );
    }

    #[test]
    fn the_staged_map_can_still_be_recalibrated() {
        // The other half of the URL rule, in the staged slot: a URL the slot is
        // already showing is a correction, and it must win.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            staged(calibrate("/uploads/next.png", 64.0, 0.0, "#ffffff52")),
        );

        state.handle(
            ClientId(1),
            staged(calibrate("/uploads/next.png", 96.0, 3.0, "#aabbccdd")),
        );

        assert_eq!(state.staged.as_ref().map(|m| m.grid_px), Some(96.0));
        assert_eq!(
            state
                .calibrations
                .get("/uploads/next.png")
                .map(|c| c.grid_px),
            Some(96.0),
            "and the correction is what gets remembered"
        );
    }

    #[test]
    fn a_staged_map_is_worth_saving_and_survives_the_trip() {
        // Slate is off between sessions, so a map staged on Sunday for next week
        // is only useful if the file holds it.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        assert!(
            state.handle(
                ClientId(1),
                staged(set_map("/uploads/next.png", 80.0, 0.0, 0.0))
            ),
            "staging should mark the room dirty"
        );

        let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
        let saved: Saved = serde_json::from_slice(&json).expect("decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());

        assert_eq!(
            restored.staged.as_ref().map(|m| m.url.as_str()),
            Some("/uploads/next.png")
        );
        assert_eq!(restored.staged.as_ref().map(|m| m.grid_px), Some(80.0));
    }

    #[test]
    fn only_the_dm_is_told_the_staged_slot_changed() {
        let mut state = room();
        let dm = ClientId(1);
        let player = ClientId(2);
        let _dm_rx = join_as_dm(&mut state, dm);
        let _player_rx = join_as_player(&mut state, player, "vex");

        assert!(state.message_for(dm, dm, &Event::StagedChanged).is_some());
        assert!(
            state
                .message_for(player, dm, &Event::StagedChanged)
                .is_none()
        );
        assert!(
            state
                .message_for(ClientId(3), dm, &Event::StagedChanged)
                .is_none(),
            "a connection with no identity is told nothing either"
        );
    }

    // --- preparing the next room ----------------------------------------------

    /// A room with a map staged and the DM's echo of that already drained.
    fn staged_room(dm: ClientId) -> (RoomState, mpsc::Receiver<ServerMsg>) {
        let mut state = room();
        let mut rx = join_as_dm(&mut state, dm);
        stage(&mut state, dm, "/uploads/next.png");
        drain(&mut rx);
        (state, rx)
    }

    /// Drops a token onto a cell of one board or the other.
    fn drop_at(id: &TokenId, x: f32, y: f32, staged: bool) -> ClientMsg {
        ClientMsg::MoveToken {
            id: id.clone(),
            x,
            y,
            dragging: false,
            staged,
        }
    }

    #[test]
    fn planning_a_move_leaves_the_token_where_it_stands() {
        // The whole state model in one assertion: one token, two positions, and
        // only the plan is what a preview drag writes.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let before = token(&state, "t1");

        state.handle(ClientId(1), drop_at(&before.id, 11.4, 7.6, true));

        let after = token(&state, "t1");
        assert_eq!((after.x, after.y), (before.x, before.y));
        assert_eq!(after.staged_pos, Some(Pos { x: 11.5, y: 7.5 }));
        assert!(!after.staged_only, "it is still on the board");
    }

    #[test]
    fn a_plan_settles_on_the_lattice_its_size_belongs_to() {
        // `snap_to_cell` is the server's alone and does not care which of a
        // token's two positions it is settling — a 2×2 lands on a cell corner
        // either way.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        state.handle(ClientId(1), create("Ogre Chief", 2.0, Owner::Dm));
        let id = made(&state, "Ogre Chief").id;

        state.handle(ClientId(1), drop_at(&id, 4.4, 9.6, true));
        assert_eq!(
            made(&state, "Ogre Chief").staged_pos,
            Some(Pos { x: 4.0, y: 10.0 })
        );
    }

    #[test]
    fn a_dragged_plan_is_relayed_unsnapped_and_the_drop_settles_it() {
        // The two message rates, on the plan. A second DM tab watches the drag
        // exactly as it watches one on the board.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let mut other_tab = join_as_dm(&mut state, ClientId(2));
        let id = token(&state, "t1").id;

        state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: id.clone(),
                x: 3.3,
                y: 4.7,
                dragging: true,
                staged: true,
            },
        );
        assert_eq!(
            token(&state, "t1").staged_pos,
            Some(Pos { x: 3.3, y: 4.7 }),
            "a drag frame is left exactly where the pointer was"
        );
        assert!(matches!(
            other_tab.try_recv(),
            Ok(ServerMsg::TokenMoved {
                staged: true,
                dragging: true,
                ..
            })
        ));

        state.handle(ClientId(1), drop_at(&id, 3.3, 4.7, true));
        assert_eq!(token(&state, "t1").staged_pos, Some(Pos { x: 3.5, y: 4.5 }));
    }

    #[test]
    fn a_plan_is_a_frame_the_table_never_receives() {
        // The `StagedChanged` arm, at token scale. A plan is a cell on a map the
        // players have not been shown, so the frame carrying it does not exist
        // for them — it is not sent and left undrawn.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        let id = token(&state, "t2").id; // Vex's own token

        state.handle(ClientId(1), drop_at(&id, 15.0, 15.0, true));

        assert!(
            drain(&mut vex).is_empty(),
            "a plan for a player's own token is still not theirs to know"
        );
    }

    #[test]
    fn a_plan_needs_a_map_to_be_a_plan_about() {
        // Refused the way promoting nothing is refused. Allowing it would mint
        // staged state belonging to a staged map that does not exist.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let id = token(&state, "t1").id;

        assert!(
            state
                .check(ClientId(1), &drop_at(&id, 2.0, 2.0, true))
                .is_err()
        );
        assert!(state.check(ClientId(1), &create_staged("Goblin")).is_err());
        // And the same commands are fine the moment there is one.
        stage(&mut state, ClientId(1), "/uploads/next.png");
        assert!(
            state
                .check(ClientId(1), &drop_at(&id, 2.0, 2.0, true))
                .is_ok()
        );
        assert!(state.check(ClientId(1), &create_staged("Goblin")).is_ok());
    }

    #[test]
    fn only_the_dm_may_plan_a_move() {
        // A player may move their own token; the plan for it is not theirs.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let _vex = join_as_player(&mut state, ClientId(2), "vex");
        let id = token(&state, "t2").id;

        assert!(
            state
                .check(ClientId(2), &drop_at(&id, 2.0, 2.0, false))
                .is_ok()
        );
        assert!(
            state
                .check(ClientId(2), &drop_at(&id, 2.0, 2.0, true))
                .is_err()
        );
    }

    #[test]
    fn a_staged_only_token_is_nowhere_the_table_can_reach() {
        // The `hidden` filter, arrived at by the other of its two routes. This
        // creature was never on the board rather than taken off it, and every
        // door out of the room has to be shut just the same.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(1), create_staged("Ambusher"));
        let id = made(&state, "Ambusher").id;

        let view = state.snapshot_for(&as_player("vex"));
        assert!(!names(&view).contains(&"Ambusher"));
        let json = serde_json::to_string(&view).expect("serialises");
        assert!(!json.contains("Ambusher"), "leaked into a snapshot: {json}");

        // Nor as a delta: neither the creation nor a plan dragged around after.
        state.handle(ClientId(1), drop_at(&id, 9.0, 9.0, true));
        state.handle(ClientId(1), drop_at(&id, 9.0, 9.0, false));
        assert!(
            drain(&mut vex).is_empty(),
            "the table heard about it anyway"
        );
    }

    #[test]
    fn the_dms_own_live_board_does_not_hold_a_staged_only_token_either() {
        // Not a detail: switching back to `Map` mode has to show the board as
        // the table sees it, and the DM's snapshot is where that starts. The
        // token is present — it is theirs to drag — and flagged as not real yet.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        state.handle(ClientId(1), create_staged("Ambusher"));

        let ambusher = made(&state, "Ambusher");
        assert!(ambusher.staged_only);
        assert_eq!(
            ambusher.staged_pos,
            Some(Pos {
                x: ambusher.x,
                y: ambusher.y
            }),
            "built somewhere, and that somewhere is its plan"
        );

        let view = state.snapshot_for(&Identity::Dm);
        let sent = view
            .tokens
            .iter()
            .find(|t| t.name == "Ambusher")
            .expect("the DM holds it");
        assert!(sent.staged_only, "and knows not to draw it on the board");
    }

    #[test]
    fn a_staged_only_token_has_no_position_on_the_board_to_move() {
        // The complement of "a plan needs a staged map". The client never offers
        // this, because the token is absent from the live board; refusing says
        // so rather than writing a field the next promote overwrites.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        state.handle(ClientId(1), create_staged("Ambusher"));
        let id = made(&state, "Ambusher").id;

        let err = state
            .check(ClientId(1), &drop_at(&id, 1.0, 1.0, false))
            .expect_err("should be refused");
        assert!(err.contains("Ambusher"), "should name the token: {err}");
        assert!(
            state
                .check(ClientId(1), &drop_at(&id, 1.0, 1.0, true))
                .is_ok()
        );
    }

    #[test]
    fn a_staged_only_token_cannot_be_rolled_into_combat() {
        // Combat is the fight happening now, and building next room's order in
        // advance needs rolls nobody has made.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        state.handle(ClientId(1), create_staged("Ambusher"));
        let id = made(&state, "Ambusher").id;

        let err = state
            .check(
                ClientId(1),
                &ClientMsg::SetInitiative {
                    token: id,
                    value: 17,
                },
            )
            .expect_err("should be refused");
        assert!(err.contains("Ambusher"), "should name the token: {err}");
        assert!(state.initiative.entries.is_empty());
    }

    #[test]
    fn an_edit_reaches_both_boards_at_once() {
        // Only position and existence fork. A resize applies to the token, and
        // therefore to its plan as well — missed, a token resized after being
        // planned straddles half a cell the moment it is promoted.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        state.handle(ClientId(1), create("Dire Wolf", 1.0, Owner::Dm));
        let wolf = made(&state, "Dire Wolf");
        state.handle(ClientId(1), drop_at(&wolf.id, 6.5, 4.5, true));

        let grown = match edit(&made(&state, "Dire Wolf")) {
            ClientMsg::UpdateToken {
                id,
                name,
                img,
                owner,
                hidden,
                hp,
                ..
            } => ClientMsg::UpdateToken {
                id,
                name,
                img,
                size: 2.0,
                owner,
                hidden,
                hp,
            },
            other => other,
        };
        state.handle(ClientId(1), grown);

        let after = made(&state, "Dire Wolf");
        assert_eq!(after.size, 2.0);
        assert_eq!(
            after.staged_pos,
            Some(Pos { x: 7.0, y: 5.0 }),
            "the plan moved onto the even lattice with the token"
        );
    }

    #[test]
    fn promoting_applies_every_plan_and_empties_the_fields() {
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let planned = token(&state, "t1").id;
        state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
        state.handle(ClientId(1), create_staged("Ambusher"));
        let unplanned_before = token(&state, "t6");

        state.handle(ClientId(1), ClientMsg::PromoteStaged);

        let grog = token(&state, "t1");
        assert_eq!((grog.x, grog.y), (20.5, 1.5), "the plan came true");
        assert_eq!(grog.staged_pos, None, "and stopped being a plan");

        let ambusher = made(&state, "Ambusher");
        assert!(!ambusher.staged_only, "it exists on the board now");
        assert_eq!(ambusher.staged_pos, None);

        let after = token(&state, "t6");
        assert_eq!(
            (after.x, after.y),
            (unplanned_before.x, unplanned_before.y),
            "a token with no plan is still the DM's to reposition"
        );
    }

    #[test]
    fn a_promote_says_three_different_things_to_three_recipients() {
        let (mut state, mut dm_rx) = staged_room(ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");

        let moving = token(&state, "t1").id; // seen all along, and planned
        state.handle(ClientId(1), drop_at(&moving, 20.5, 1.5, true));
        state.handle(ClientId(1), create_staged("Ambusher")); // never seen
        let ambusher = made(&state, "Ambusher").id;
        drain(&mut dm_rx);
        drain(&mut vex);

        state.handle(ClientId(1), ClientMsg::PromoteStaged);

        // The DM gets whole tokens, because their client holds the two fields
        // that were just emptied and no `TokenMoved` could tell them so.
        let to_dm = drain(&mut dm_rx);
        for id in [&moving, &ambusher] {
            assert!(
                to_dm.iter().any(|msg| matches!(
                    msg,
                    ServerMsg::TokenChanged { token }
                        if &token.id == id && token.staged_pos.is_none() && !token.staged_only
                )),
                "the DM was not told {id:?} had its plan applied: {to_dm:?}"
            );
        }

        let to_vex = drain(&mut vex);
        // A creation for the one they are meeting for the first time…
        assert!(
            to_vex.iter().any(|msg| matches!(
                msg,
                ServerMsg::TokenChanged { token } if token.id == ambusher
            )),
            "the ambusher should arrive as a creation: {to_vex:?}"
        );
        // …and a plain move for the one they have been watching all along.
        assert!(
            to_vex.iter().any(|msg| matches!(
                msg,
                ServerMsg::TokenMoved { id, x, y, .. } if id == &moving && (*x, *y) == (20.5, 1.5)
            )),
            "the planned token should arrive as a move: {to_vex:?}"
        );
        assert!(
            !to_vex
                .iter()
                .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.id == moving)),
            "and not also as an edit: {to_vex:?}"
        );
    }

    #[test]
    fn a_promote_leaves_a_still_hidden_creature_unannounced() {
        // A promote settles `staged_only`. It says nothing about a monster the
        // DM also took off the board, and the table must not meet it early.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(
            ClientId(1),
            with(create_staged("Ambusher"), |hidden, _| *hidden = true),
        );
        drain(&mut vex);

        state.handle(ClientId(1), ClientMsg::PromoteStaged);

        let to_vex = drain(&mut vex);
        assert!(
            to_vex
                .iter()
                .all(|msg| matches!(msg, ServerMsg::MapChanged { .. })),
            "only the map should have reached the table: {to_vex:?}"
        );
        assert!(made(&state, "Ambusher").hidden, "and it is still hidden");
    }

    #[test]
    fn discarding_the_staged_map_takes_the_plans_made_on_it_with_it() {
        // Otherwise the next map inherits monsters placed on a map nobody will
        // ever see again — and staged-only tokens no board draws at all.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let planned = token(&state, "t1").id;
        state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
        state.handle(ClientId(1), create_staged("Ambusher"));
        let before = state.tokens.len();

        state.handle(ClientId(1), ClientMsg::ClearStaged);

        assert_eq!(token(&state, "t1").staged_pos, None);
        assert_eq!(state.tokens.len(), before - 1, "the ambusher is gone");
        assert!(state.tokens.values().all(|t| !t.staged_only));
        assert_eq!(
            (token(&state, "t1").x, token(&state, "t1").y),
            (3.5, 3.5),
            "and the board itself was never touched"
        );
    }

    #[test]
    fn discarding_a_plan_is_not_something_the_table_is_told_about() {
        // A player's copy of a planned token is identical either side of this,
        // so the only thing a frame could carry them is the news that the DM
        // just threw a plan away — which is news, and invariant 4's concern.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        let planned = token(&state, "t1").id;
        state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
        state.handle(ClientId(1), create_staged("Ambusher"));
        drain(&mut vex);

        state.handle(ClientId(1), ClientMsg::ClearStaged);

        assert!(
            drain(&mut vex).is_empty(),
            "nothing about this was the table's to hear"
        );
    }

    #[test]
    fn the_dm_is_told_when_a_plan_is_cleared_out_from_under_them() {
        let (mut state, mut dm_rx) = staged_room(ClientId(1));
        let planned = token(&state, "t1").id;
        state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
        state.handle(ClientId(1), create_staged("Ambusher"));
        let ambusher = made(&state, "Ambusher").id;
        drain(&mut dm_rx);

        state.handle(ClientId(1), ClientMsg::ClearStaged);

        let msgs = drain(&mut dm_rx);
        assert!(
            msgs.iter().any(|msg| matches!(
                msg,
                ServerMsg::TokenChanged { token }
                    if token.id == planned && token.staged_pos.is_none()
            )),
            "the cleared plan should reach the DM's other tabs: {msgs:?}"
        );
        assert!(
            msgs.iter()
                .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id == &ambusher)),
            "and so should the deleted token: {msgs:?}"
        );
    }

    #[test]
    fn staging_a_different_map_clears_the_plans_but_recalibrating_does_not() {
        // The arm that gets missed. `SetMap` already tells a load from a
        // recalibration by URL; correcting the grid after placing an ambush is
        // an ordinary thing to do and must not sweep the ambush away.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let planned = token(&state, "t1").id;
        state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
        state.handle(ClientId(1), create_staged("Ambusher"));

        state.handle(
            ClientId(1),
            staged(calibrate("/uploads/next.png", 96.0, 4.0, "#aabbccdd")),
        );
        assert_eq!(
            token(&state, "t1").staged_pos,
            Some(Pos { x: 20.5, y: 1.5 }),
            "a recalibration is not a new next room"
        );
        assert!(made(&state, "Ambusher").staged_only);

        stage(&mut state, ClientId(1), "/uploads/somewhere-else.png");
        assert_eq!(token(&state, "t1").staged_pos, None);
        assert!(
            state.tokens.values().all(|t| t.name != "Ambusher"),
            "a monster placed for a room nobody will visit should not follow"
        );
    }

    #[test]
    fn loading_a_new_board_leaves_the_plans_for_the_next_one_alone() {
        // A plan describes a cell on the staged map, which this has not touched.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let planned = token(&state, "t1").id;
        state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));

        state.handle(
            ClientId(1),
            set_map("/uploads/somewhere.png", 64.0, 0.0, 0.0),
        );

        assert_eq!(
            token(&state, "t1").staged_pos,
            Some(Pos { x: 20.5, y: 1.5 })
        );
    }

    #[test]
    fn deleting_a_token_takes_its_plan_with_it() {
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        state.handle(ClientId(1), create("Dire Wolf", 1.0, Owner::Dm));
        let id = made(&state, "Dire Wolf").id;
        state.handle(ClientId(1), drop_at(&id, 12.5, 12.5, true));

        state.handle(ClientId(1), ClientMsg::DeleteToken { id: id.clone() });

        assert!(!state.tokens.contains_key(&id));
    }

    #[test]
    fn a_plan_is_worth_saving_and_survives_the_trip() {
        // Slate is off between sessions, and the whole point of preparing the
        // next room is that it is prepared on a different evening.
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let planned = token(&state, "t1").id;
        assert!(
            state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true)),
            "planning should mark the room dirty"
        );
        state.handle(ClientId(1), create_staged("Ambusher"));

        let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
        let saved: Saved = serde_json::from_slice(&json).expect("decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());

        assert_eq!(
            token(&restored, "t1").staged_pos,
            Some(Pos { x: 20.5, y: 1.5 })
        );
        assert!(made(&restored, "Ambusher").staged_only);
    }

    #[test]
    fn a_dragged_plan_is_not_worth_saving_but_the_drop_is() {
        let (mut state, _dm_rx) = staged_room(ClientId(1));
        let id = token(&state, "t1").id;

        assert!(
            !state.handle(
                ClientId(1),
                ClientMsg::MoveToken {
                    id: id.clone(),
                    x: 5.0,
                    y: 5.0,
                    dragging: true,
                    staged: true,
                }
            ),
            "a plan is dragged into place like a token, and costs the disk as little"
        );
        assert!(state.handle(ClientId(1), drop_at(&id, 5.0, 5.0, true)));
    }

    #[test]
    fn an_unusable_grid_size_is_refused() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for px in [0.0, -70.0, 0.5, 1e9] {
            assert!(
                state
                    .check(ClientId(1), &set_map("/assets/map.png", px, 0.0, 0.0))
                    .is_err(),
                "{px} should be refused"
            );
        }
        assert!(
            state
                .check(ClientId(1), &set_map("/assets/map.png", 4.0, 0.0, 0.0))
                .is_ok()
        );
        assert!(
            state
                .check(ClientId(1), &set_map("/assets/map.png", 4096.0, 0.0, 0.0))
                .is_ok()
        );
    }

    #[test]
    fn an_empty_or_absurd_map_url_is_refused() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        assert!(
            state
                .check(ClientId(1), &set_map("", 64.0, 0.0, 0.0))
                .is_err()
        );
        let long = "/uploads/".to_owned() + &"a".repeat(MAX_URL_LEN);
        assert!(
            state
                .check(ClientId(1), &set_map(&long, 64.0, 0.0, 0.0))
                .is_err()
        );
    }

    #[test]
    fn only_a_hex_rgba_colour_is_accepted() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for good in ["#ffffff52", "#000000ff", "#FFAA0080", "#00000000"] {
            assert!(
                state.check(ClientId(1), &set_color(good)).is_ok(),
                "{good} should be fine"
            );
        }

        for bad in [
            "#ffffff", // no alpha; the part that matters most would be missing
            "#fff",
            "ffffff52", // no hash
            "#gggggggg",
            "#ffffff521",
            "",
            "rgba(255, 255, 255, 0.3)",
            "white",
            "#ffffff5\u{00e9}", // nine bytes, but not nine hex digits
        ] {
            assert!(
                state.check(ClientId(1), &set_color(bad)).is_err(),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn the_default_grid_colour_is_one_the_server_would_accept() {
        // The default ships in `MapInfo::default` and is what every old save
        // gets filled in with, so it has to pass the same check as any other.
        assert!(is_hex_rgba(&MapInfo::default().grid_color));
    }

    #[test]
    fn the_grid_colour_survives_a_change() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), set_color("#33ff9980"));
        assert_eq!(state.map.grid_color, "#33ff9980");
    }

    #[test]
    fn a_play_area_defaults_to_the_whole_image() {
        // The server never sees the image, so `None` is the only thing it could
        // mean by "all of it" — and it is what every older save says.
        assert_eq!(room().map.play_area, None);
    }

    #[test]
    fn a_play_area_survives_a_change() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), set_area(rect(128.0, 64.0, 640.0, 448.0)));
        assert_eq!(state.map.play_area, rect(128.0, 64.0, 640.0, 448.0));
    }

    #[test]
    fn a_play_area_can_be_cleared_back_to_the_whole_image() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), set_area(rect(128.0, 64.0, 640.0, 448.0)));
        state.handle(ClientId(1), set_area(None));
        assert_eq!(state.map.play_area, None);
    }

    #[test]
    fn an_unusable_play_area_is_refused() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        let bad = [
            rect(0.0, 0.0, 0.0, 100.0),    // no width
            rect(0.0, 0.0, 100.0, 0.0),    // no height
            rect(0.0, 0.0, -640.0, 448.0), // inside out
            rect(0.0, 0.0, 1.0e9, 448.0),  // more grid lines than frames
            rect(0.0, 0.0, 640.0, 1.0e9),
            rect(f32::NAN, 0.0, 640.0, 448.0),
            rect(0.0, 0.0, 10.0, 448.0), // narrower than one 64 px cell
        ];
        for area in bad {
            assert!(
                state.check(ClientId(1), &set_area(area)).is_err(),
                "{area:?} should be refused"
            );
        }

        assert!(
            state
                .check(ClientId(1), &set_area(rect(0.0, 0.0, 64.0, 64.0)))
                .is_ok()
        );
        assert!(
            state.check(ClientId(1), &set_area(None)).is_ok(),
            "the whole image is always fine"
        );
    }

    #[test]
    fn a_negative_play_area_origin_is_allowed() {
        // The origin is not bounded the way the size is: a DM may legitimately
        // rule a board that starts off the top-left of the image, and the client
        // clips to the image before it draws anything.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        assert!(
            state
                .check(ClientId(1), &set_area(rect(-320.0, -64.0, 640.0, 448.0)))
                .is_ok()
        );
    }

    #[test]
    fn a_map_change_reaches_the_dm_who_made_it() {
        // Unlike a drag frame there is no local prediction to rubber-band, so
        // the originator needs this echo to see the grid it asked for.
        let state = room();
        let me = ClientId(1);
        assert!(state.message_for(me, me, &Event::MapChanged).is_some());
        assert!(
            state
                .message_for(ClientId(2), me, &Event::MapChanged)
                .is_some()
        );
    }

    #[test]
    fn a_map_change_is_worth_saving() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        assert!(state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 1.0, 2.0)));
    }

    // --- drawings -------------------------------------------------------------

    const INK: &str = "#ff8c42e6";

    fn add_shape(kind: ShapeKind, from: Origin, to: (f32, f32)) -> ClientMsg {
        ClientMsg::AddShape {
            kind,
            from,
            to: Pos { x: to.0, y: to.1 },
            color: INK.to_owned(),
        }
    }

    /// An unanchored circle, which is the ordinary case.
    fn circle_at(x: f32, y: f32) -> ClientMsg {
        add_shape(ShapeKind::Circle, Origin::Point(Pos { x, y }), (4.0, 0.0))
    }

    fn sketch(at: (f32, f32), drawing: bool) -> ClientMsg {
        ClientMsg::Sketch {
            kind: ShapeKind::Line,
            at: Pos { x: at.0, y: at.1 },
            to: Pos { x: 3.0, y: 4.0 },
            color: INK.to_owned(),
            drawing,
        }
    }

    /// The shapes as one recipient is actually sent them.
    fn shapes_seen(state: &RoomState, who: &Identity) -> Vec<ShapeId> {
        state
            .snapshot_for(who)
            .shapes
            .into_iter()
            .map(|s| s.id)
            .collect()
    }

    fn only_shape(state: &RoomState) -> Shape {
        match state.shapes.as_slice() {
            [shape] => shape.clone(),
            other => panic!("expected exactly one shape, found {}", other.len()),
        }
    }

    #[test]
    fn anyone_may_draw_and_the_server_names_the_shape() {
        // The first thing a player may add to the room. No `require_dm` on the
        // way in, unlike every other command that creates something.
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(2), "vex");

        assert!(state.handle(ClientId(2), circle_at(3.0, 4.0)));

        let shape = only_shape(&state);
        assert!(!shape.id.0.is_empty(), "the server invents the id");
        assert_eq!(shape.by, Owner::Player(PlayerId::new("vex")));
        assert_eq!(shape.kind, ShapeKind::Circle);
        assert_eq!(shape.anchor(), None);
    }

    #[test]
    fn a_player_may_erase_their_own_drawing_and_not_someone_elses() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let _vex = join_as_player(&mut state, ClientId(2), "vex");
        let _grog = join_as_player(&mut state, ClientId(3), "grog");

        state.handle(ClientId(2), circle_at(3.0, 4.0));
        let id = only_shape(&state).id;

        assert_eq!(
            state.check(ClientId(3), &ClientMsg::RemoveShape { id: id.clone() }),
            Err("that is not yours to erase".to_owned()),
            "grog did not draw it"
        );
        // The DM may erase anything, and so may whoever drew it.
        assert!(
            state
                .check(ClientId(1), &ClientMsg::RemoveShape { id: id.clone() })
                .is_ok()
        );
        assert!(
            state
                .check(ClientId(2), &ClientMsg::RemoveShape { id: id.clone() })
                .is_ok()
        );

        state.handle(ClientId(2), ClientMsg::RemoveShape { id });
        assert!(state.shapes.is_empty());
    }

    #[test]
    fn only_the_dm_may_sweep_the_board() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(2), circle_at(3.0, 4.0));

        assert_eq!(
            state.check(ClientId(2), &ClientMsg::ClearShapes),
            Err("only the DM can clear the board".to_owned())
        );
        assert_eq!(state.shapes.len(), 1, "and nothing was cleared");
    }

    #[test]
    fn an_aura_on_a_hidden_monster_is_not_on_the_tables_board() {
        // The leak this milestone had to close early. The roadmap files anchor
        // visibility under fog of war, but `hidden` exists now, and a shape that
        // follows a token is that token's position drawn in colour.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), create_hidden("Ambusher"));
        let ambusher = made(&state, "Ambusher").id;

        state.handle(
            ClientId(1),
            add_shape(
                ShapeKind::Circle,
                Origin::Token(ambusher.clone()),
                (2.0, 0.0),
            ),
        );

        assert_eq!(shapes_seen(&state, &as_player("vex")), Vec::new());
        assert_eq!(shapes_seen(&state, &Identity::Dm).len(), 1);

        // And not merely absent from the list — the id must not be in the bytes
        // at all, which is how invariant 4 has to be checked.
        let json = serde_json::to_string(&state.snapshot_for(&as_player("vex"))).expect("encodes");
        assert!(!json.contains(&ambusher.0));
    }

    #[test]
    fn revealing_a_monster_brings_what_is_drawn_on_it_along() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(1), create_hidden("Ambusher"));
        let monster = made(&state, "Ambusher");

        state.handle(
            ClientId(1),
            add_shape(
                ShapeKind::Circle,
                Origin::Token(monster.id.clone()),
                (2.0, 0.0),
            ),
        );
        drain(&mut vex);

        state.handle(ClientId(1), set_hidden(&monster, false));

        let frames = drain(&mut vex);
        let shapes = frames.iter().find_map(|f| match f {
            ServerMsg::ShapesChanged { shapes } => Some(shapes),
            _ => None,
        });
        assert_eq!(
            shapes.map(Vec::len),
            Some(1),
            "the aura arrives with the monster"
        );

        // And hiding it again takes it back off their board.
        let monster = made(&state, "Ambusher");
        state.handle(ClientId(1), set_hidden(&monster, true));
        assert_eq!(shapes_seen(&state, &as_player("vex")), Vec::new());
    }

    #[test]
    fn hiding_a_token_nothing_is_drawn_on_says_nothing_about_shapes() {
        // The gate that keeps this from becoming an announcement. A player who
        // is sent a `ShapesChanged` every time the DM hides something learns
        // that the DM hid something, which is the thing being withheld.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(1), circle_at(3.0, 4.0));
        let ogre = token(&state, "t6");
        drain(&mut vex);

        state.handle(ClientId(1), set_hidden(&ogre, true));

        assert!(
            !drain(&mut vex)
                .iter()
                .any(|f| matches!(f, ServerMsg::ShapesChanged { .. })),
            "nothing was anchored to the ogre"
        );
    }

    #[test]
    fn a_player_cannot_anchor_to_a_token_they_cannot_see() {
        // Refused in the same words a token that does not exist is refused. Two
        // different answers here would turn this into an oracle: sweep the id
        // space, and the refusals map out the DM's monsters.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let _vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(1), create_hidden("Ambusher"));
        let hidden = made(&state, "Ambusher").id;

        let refusal = state.check(
            ClientId(2),
            &add_shape(ShapeKind::Circle, Origin::Token(hidden.clone()), (2.0, 0.0)),
        );
        assert_eq!(refusal, Err(format!("no such token: {}", hidden.0)));
        assert_eq!(
            state.check(
                ClientId(2),
                &add_shape(
                    ShapeKind::Circle,
                    Origin::Token(TokenId::new("nonsense")),
                    (2.0, 0.0)
                ),
            ),
            Err("no such token: nonsense".to_owned()),
            "and a token nobody has is refused identically"
        );

        // The DM may anchor to it: it is their monster and their board.
        assert!(
            state
                .check(
                    ClientId(1),
                    &add_shape(ShapeKind::Circle, Origin::Token(hidden), (2.0, 0.0))
                )
                .is_ok()
        );
    }

    #[test]
    fn a_player_cannot_erase_a_drawing_they_are_not_sent() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let _vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(1), create_hidden("Ambusher"));
        let monster = made(&state, "Ambusher").id;
        state.handle(
            ClientId(1),
            add_shape(ShapeKind::Circle, Origin::Token(monster), (2.0, 0.0)),
        );
        let id = only_shape(&state).id;

        assert_eq!(
            state.check(ClientId(2), &ClientMsg::RemoveShape { id }),
            Err("that drawing is already gone".to_owned()),
            "and not 'not yours', which would confirm it exists"
        );
    }

    #[test]
    fn deleting_a_token_takes_what_is_drawn_on_it() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let ogre = token(&state, "t6");

        state.handle(
            ClientId(1),
            add_shape(
                ShapeKind::Circle,
                Origin::Token(ogre.id.clone()),
                (2.0, 0.0),
            ),
        );
        // One that follows nothing, to prove the sweep is not indiscriminate.
        state.handle(ClientId(1), circle_at(20.0, 20.0));

        state.handle(ClientId(1), ClientMsg::DeleteToken { id: ogre.id });

        assert_eq!(state.shapes.len(), 1);
        assert_eq!(only_shape(&state).anchor(), None);
    }

    #[test]
    fn a_new_map_clears_the_drawings_and_a_recalibration_does_not() {
        // The same split the plans for the next room turn on, and the same arm
        // that gets missed: a shape describes cells on this board, so a new
        // image throws it away and correcting the grid must not.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), circle_at(3.0, 4.0));

        state.handle(ClientId(1), set_map("/assets/map.png", 80.0, 3.0, 4.0));
        assert_eq!(state.shapes.len(), 1, "recalibrating the map on the board");

        state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 0.0, 0.0));
        assert!(state.shapes.is_empty(), "a different dungeon");
    }

    #[test]
    fn staging_and_promoting_leave_the_board_swept() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), circle_at(3.0, 4.0));

        // Staging a map is not a change to the board, and shapes belong to the
        // board. Nothing is drawn on the map being prepared, so nothing goes.
        stage(&mut state, ClientId(1), "/uploads/next.webp");
        assert_eq!(state.shapes.len(), 1);

        // Promoting is a new map arriving, which is where they go.
        state.handle(ClientId(1), ClientMsg::PromoteStaged);
        assert!(state.shapes.is_empty());
    }

    #[test]
    fn a_sketch_reaches_everyone_but_the_client_sweeping_it() {
        let mut state = room();
        let mut dm = join_as_dm(&mut state, ClientId(1));
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        drain(&mut dm);
        drain(&mut vex);

        state.handle(ClientId(2), sketch((1.0, 1.0), true));

        assert!(matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::Sketch { by, .. }] if *by == ClientId(2)
        ));
        assert!(
            drain(&mut vex).is_empty(),
            "the sweeper draws it from their own pointer"
        );

        state.handle(ClientId(2), sketch((1.0, 1.0), false));
        assert!(matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::SketchEnded { by }] if *by == ClientId(2)
        ));
    }

    #[test]
    fn a_sketch_is_never_stored_and_never_saved() {
        // The whole of what makes a measuring line free: it is not in the room,
        // so there is nothing to filter, nothing to snapshot, nothing to write.
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(2), "vex");

        assert!(!state.handle(ClientId(2), sketch((1.0, 1.0), true)));
        assert!(!state.handle(ClientId(2), sketch((2.0, 2.0), false)));
        assert!(state.shapes.is_empty());
        assert!(state.snapshot_for(&Identity::Dm).shapes.is_empty());
    }

    #[test]
    fn a_client_that_vanishes_mid_sweep_does_not_strand_its_line() {
        let mut state = room();
        let mut dm = join_as_dm(&mut state, ClientId(1));
        let _vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(2), sketch((1.0, 1.0), true));
        drain(&mut dm);

        // What `RoomCmd::Disconnected` does, without the task around it.
        state.clients.remove(&ClientId(2));
        state.dispatch(ClientId(2), &[Event::SketchEnded { by: ClientId(2) }]);

        assert!(matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::SketchEnded { by }] if *by == ClientId(2)
        ));
    }

    #[test]
    fn a_shape_cannot_be_stretched_across_the_world() {
        // Bounded because every client walks the cells an area covers. An absurd
        // one is a frozen browser on five other machines, and the sketch reaches
        // them before anybody has decided to keep it.
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(2), "vex");

        let huge = ClientMsg::Sketch {
            kind: ShapeKind::Circle,
            at: Pos { x: 0.0, y: 0.0 },
            to: Pos { x: 9_000.0, y: 0.0 },
            color: INK.to_owned(),
            drawing: true,
        };
        assert!(state.check(ClientId(2), &huge).is_err());
        assert!(
            state
                .check(
                    ClientId(2),
                    &add_shape(ShapeKind::Circle, Origin::default(), (9_000.0, 0.0))
                )
                .is_err(),
            "and keeping one is bounded the same way"
        );
    }

    #[test]
    fn a_drawing_needs_a_colour_the_client_could_actually_use() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(2), "vex");

        for bad in ["", "red", "#ff8c42", "#ff8c42e6ff"] {
            let msg = ClientMsg::AddShape {
                kind: ShapeKind::Circle,
                from: Origin::default(),
                to: Pos { x: 2.0, y: 0.0 },
                color: bad.to_owned(),
            };
            assert_eq!(
                state.check(ClientId(2), &msg),
                Err("a shape colour must look like #rrggbbaa".to_owned()),
                "{bad:?} is not a colour"
            );
        }
    }

    #[test]
    fn a_board_cannot_be_filled_with_drawings_without_limit() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(2), "vex");

        // `apply` rather than `handle`, like the token cap above and for the
        // same reason: the rule under test is in `check`, and running sixty-four
        // of these through the whole pipeline only fills this test's outbound
        // mailbox and gets the drawer dropped as a wedged client.
        for _ in 0..MAX_SHAPES {
            state.apply(ClientId(2), circle_at(3.0, 4.0));
        }
        assert_eq!(state.shapes.len(), MAX_SHAPES);
        assert!(state.check(ClientId(2), &circle_at(3.0, 4.0)).is_err());
    }

    #[test]
    fn a_drawing_survives_the_save_file() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let ogre = token(&state, "t6");
        state.handle(
            ClientId(1),
            add_shape(ShapeKind::Cone, Origin::Token(ogre.id.clone()), (3.0, 3.0)),
        );

        let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
        let saved: Saved = serde_json::from_slice(&json).expect("decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());

        let shape = only_shape(&restored);
        assert_eq!(shape.kind, ShapeKind::Cone);
        assert_eq!(shape.anchor(), Some(&ogre.id));
        assert_eq!((shape.to.x, shape.to.y), (3.0, 3.0));
    }

    #[test]
    fn a_room_saved_before_drawings_existed_still_loads() {
        // Invariant 2, checked on the field this milestone added rather than
        // trusted: an older save carries no `shapes` at all.
        let saved: Saved = serde_json::from_str("{}").expect("an empty room decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());
        assert!(restored.shapes.is_empty());
    }

    // --- walls and doors ------------------------------------------------------

    /// One traced run, in image pixels. The corners are on a 64 px lattice
    /// because that is what the client's corner snap produces on the default
    /// grid, not because anything on the server cares.
    fn trace(points: &[(f32, f32)], door: bool) -> ClientMsg {
        ClientMsg::AddWalls {
            points: points.iter().map(|&(x, y)| Px { x, y }).collect(),
            door,
        }
    }

    /// A three-corner run: two segments meeting at a right angle.
    fn a_corner() -> ClientMsg {
        trace(&[(0.0, 0.0), (128.0, 0.0), (128.0, 128.0)], false)
    }

    fn wall_ids(state: &RoomState) -> Vec<WallId> {
        state.walls.iter().map(|w| w.id.clone()).collect()
    }

    #[test]
    fn a_traced_run_becomes_one_segment_per_gap_between_its_corners() {
        // The whole point of the milestone: a two-hundred-segment dungeon is one
        // command per run rather than one per segment.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(ClientId(1), a_corner());

        assert_eq!(state.walls.len(), 2);
        let first = state.walls.first().expect("the first segment");
        let second = state.walls.get(1).expect("the second segment");
        assert_eq!(first.from, Px { x: 0.0, y: 0.0 });
        assert_eq!(first.to, Px { x: 128.0, y: 0.0 });
        // Consecutive segments share a corner: the run is a polyline, and the
        // gap between two of them would be a gap fog leaks through.
        assert_eq!(second.from, first.to);
        assert_eq!(second.to, Px { x: 128.0, y: 128.0 });
        // The ids are the server's to invent, and distinct — erasing one bad
        // segment of a long trace is the reason they exist at all.
        assert_ne!(first.id, second.id);
        assert!(!first.id.0.is_empty());
    }

    #[test]
    fn a_run_of_doors_is_traced_shut() {
        // A door the DM has to close after drawing it is a door they forget to
        // close, and a dungeon's doors are shut until somebody opens them.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        state.handle(ClientId(1), trace(&[(0.0, 0.0), (64.0, 0.0)], true));

        assert_eq!(state.walls.first().expect("the door").door(), Some(false));
    }

    #[test]
    fn only_the_dm_may_trace_erase_or_open_anything() {
        // Every wall command at once: unlike the drawings, there is no
        // per-item permission underneath — the walls are all the DM's.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let _vex = join_as_player(&mut state, ClientId(2), "vex");
        state.handle(ClientId(1), trace(&[(0.0, 0.0), (64.0, 0.0)], true));
        let door = state.walls.first().expect("the door").id.clone();

        for msg in [
            a_corner(),
            ClientMsg::RemoveWall { id: door.clone() },
            ClientMsg::ToggleDoor { id: door },
            ClientMsg::ClearWalls,
        ] {
            assert!(
                state.check(ClientId(2), &msg).is_err(),
                "a player got as far as {msg:?}"
            );
        }
        assert_eq!(state.walls.len(), 1, "and none of it happened");
    }

    #[test]
    fn a_player_is_never_sent_a_wall_or_told_one_exists() {
        // Invariant 4 at its plainest. Players infer the geometry from the edges
        // of the fog; the floor plan itself is not theirs to hold, and a frame
        // they cannot use still tells them the DM just did something.
        let mut state = room();
        let dm_client = ClientId(1);
        let _dm = join_as_dm(&mut state, dm_client);
        let mut vex = join_as_player(&mut state, ClientId(2), "vex");
        drain(&mut vex);

        state.handle(dm_client, a_corner());

        let dm_view = state.snapshot_for(&Identity::Dm);
        let player_view = state.snapshot_for(&Identity::Player(PlayerId::new("vex")));
        assert_eq!(dm_view.walls.len(), 2);
        assert!(
            player_view.walls.is_empty(),
            "empty is both 'nothing traced' and 'not the DM'"
        );
        assert!(
            vex.try_recv().is_err(),
            "not even an empty walls_changed: the frame itself is news"
        );
        assert!(
            state
                .message_for(ClientId(1), dm_client, &Event::WallsChanged)
                .is_some(),
            "the DM is the one recipient it has"
        );
    }

    #[test]
    fn a_door_swings_both_ways_and_masonry_does_not() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), trace(&[(0.0, 0.0), (64.0, 0.0)], true));
        state.handle(ClientId(1), a_corner());
        let door = state.walls.first().expect("the door").id.clone();
        let solid = state.walls.get(1).expect("the masonry").id.clone();

        state.handle(ClientId(1), ClientMsg::ToggleDoor { id: door.clone() });
        assert_eq!(state.walls.first().expect("the door").door(), Some(true));
        state.handle(ClientId(1), ClientMsg::ToggleDoor { id: door });
        assert_eq!(state.walls.first().expect("the door").door(), Some(false));

        // Refused rather than ignored: it means the client and the room disagree
        // about what that segment is, and doing nothing quietly hides that.
        let err = state
            .check(ClientId(1), &ClientMsg::ToggleDoor { id: solid })
            .expect_err("masonry does not open");
        assert!(err.contains("not a door"), "{err}");
    }

    #[test]
    fn one_bad_segment_can_be_erased_without_redrawing_the_run() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), a_corner());
        let [first, second] = wall_ids(&state).try_into().expect("two segments");

        state.handle(ClientId(1), ClientMsg::RemoveWall { id: first });

        assert_eq!(wall_ids(&state), vec![second]);
    }

    #[test]
    fn erasing_a_wall_that_is_already_gone_is_refused_not_ignored() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        let err = state
            .check(
                ClientId(1),
                &ClientMsg::RemoveWall {
                    id: WallId("nothing".to_owned()),
                },
            )
            .expect_err("refused");
        assert!(err.contains("already gone"), "{err}");
    }

    #[test]
    fn a_new_map_clears_the_walls_and_a_recalibration_does_not() {
        // The arm that gets missed, for the third feature in a row. A wall
        // traces the art of *this* image, so a new one throws it away — and
        // correcting the grid does not touch the art at all, which is exactly
        // the order the DM does these two things in.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), a_corner());

        state.handle(ClientId(1), set_map("/assets/map.png", 80.0, 3.0, 4.0));
        assert_eq!(state.walls.len(), 2, "recalibrating leaves the tracing");

        state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 0.0, 0.0));
        assert!(state.walls.is_empty(), "a different dungeon");
    }

    #[test]
    fn staging_leaves_the_walls_and_promoting_sweeps_them() {
        // There are no staged walls — that is the scene concept CLAUDE.md rules
        // out — so staging a map cannot touch the ones on the board, and a
        // promote is a load like any other.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), a_corner());

        stage(&mut state, ClientId(1), "/uploads/next.webp");
        assert_eq!(state.walls.len(), 2);

        state.handle(ClientId(1), ClientMsg::PromoteStaged);
        assert!(state.walls.is_empty());
    }

    #[test]
    fn a_map_load_with_nothing_traced_announces_nothing() {
        // The gate on `sweep_board`, which is the same gate the initiative panel
        // uses. An unconditional frame on every map load is a message about a
        // board that had nothing on it.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        let events = state.apply(ClientId(1), set_map("/uploads/cave.webp", 70.0, 0.0, 0.0));

        assert!(
            !events
                .iter()
                .any(|e| matches!(e, Event::WallsChanged | Event::ShapesChanged)),
            "swept a board that was already empty: {events:?}"
        );
    }

    #[test]
    fn a_run_needs_two_corners_and_cannot_run_forever() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        // One click is a run that was never finished; the client does not send
        // it, and it would store nothing if it did.
        assert!(
            state
                .check(ClientId(1), &trace(&[(0.0, 0.0)], false))
                .is_err()
        );

        let too_many: Vec<(f32, f32)> = (0..=MAX_WALL_POINTS as i32)
            .map(|i| (i as f32 * 64.0, 0.0))
            .collect();
        assert!(state.check(ClientId(1), &trace(&too_many, false)).is_err());
    }

    #[test]
    fn a_map_cannot_be_filled_with_walls_without_limit() {
        // `apply` rather than `handle`, like the drawings cap and for the same
        // reason: the rule is in `check`, and pushing this many through the
        // whole pipeline only fills the test's mailbox.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        // Each run is one segment, so this reaches the cap exactly.
        for i in 0..MAX_WALLS {
            state.apply(
                ClientId(1),
                trace(&[(i as f32, 0.0), (i as f32, 64.0)], false),
            );
        }
        assert_eq!(state.walls.len(), MAX_WALLS);

        // And the check counts segments the run *would* add, not commands.
        assert!(
            state
                .check(ClientId(1), &trace(&[(0.0, 0.0), (64.0, 0.0)], false))
                .is_err()
        );
    }

    #[test]
    fn a_corner_off_the_map_is_refused() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for bad in [f32::NAN, f32::INFINITY, MAX_MAP_PX * 2.0] {
            assert!(
                state
                    .check(ClientId(1), &trace(&[(0.0, 0.0), (bad, 0.0)], false))
                    .is_err(),
                "{bad} should be refused"
            );
        }
        // A corner a shade outside the image is not: a DM tracing right up to
        // the edge should not have a click refused for landing a pixel over it.
        assert!(
            state
                .check(ClientId(1), &trace(&[(-4.0, -4.0), (64.0, 0.0)], false))
                .is_ok()
        );
    }

    #[test]
    fn a_traced_dungeon_survives_the_save_file() {
        // The one thing on `Saved` that would make this feature unusable if it
        // were not persisted: the map is still on the board next week.
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), a_corner());
        state.handle(ClientId(1), trace(&[(0.0, 0.0), (0.0, 64.0)], true));
        let door = state.walls.last().expect("the door").id.clone();
        state.handle(ClientId(1), ClientMsg::ToggleDoor { id: door.clone() });

        let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
        let saved: Saved = serde_json::from_slice(&json).expect("decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());

        assert_eq!(restored.walls.len(), 3);
        let reopened = restored.walls.last().expect("the door");
        assert_eq!(reopened.id, door);
        assert_eq!(reopened.door(), Some(true), "an open door stays open");
        assert_eq!(reopened.from, Px { x: 0.0, y: 0.0 });
    }

    #[test]
    fn a_room_saved_before_walls_existed_still_loads() {
        // Invariant 2 again, on this milestone's field. And the default matters
        // beyond loading: a segment that defaulted to an open door would quietly
        // stop blocking anything the moment fog arrives.
        let saved: Saved = serde_json::from_str("{}").expect("an empty room decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());
        assert!(restored.walls.is_empty());
        assert_eq!(WallKind::default(), WallKind::Solid);
    }

    #[test]
    fn a_wall_is_worth_saving() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        assert!(state.handle(ClientId(1), a_corner()));
    }

    // --- non-finite numbers -------------------------------------------------

    #[test]
    fn a_non_finite_coordinate_is_refused_before_it_can_reach_the_save_file() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let msg = ClientMsg::MoveToken {
                id: TokenId::new("t1"),
                x: bad,
                y: 0.0,
                dragging: false,
                staged: false,
            };
            assert!(
                state.check(ClientId(1), &msg).is_err(),
                "{bad} should be refused"
            );

            let msg = ClientMsg::MoveToken {
                id: TokenId::new("t1"),
                x: 0.0,
                y: bad,
                dragging: true,
                staged: false,
            };
            assert!(
                state.check(ClientId(1), &msg).is_err(),
                "{bad} should be refused"
            );

            assert!(
                state
                    .check(ClientId(1), &set_map("/a.png", bad, 0.0, 0.0))
                    .is_err()
            );
            assert!(
                state
                    .check(ClientId(1), &set_map("/a.png", 64.0, bad, 0.0))
                    .is_err()
            );
            assert!(
                state
                    .check(ClientId(1), &set_map("/a.png", 64.0, 0.0, bad))
                    .is_err()
            );
        }
    }

    #[test]
    fn a_number_that_only_overflows_once_narrowed_to_f32_is_still_caught() {
        // The path that makes the check above worth having. `NaN` is not valid
        // JSON and `1e400` is rejected as out of range, so both stop at the
        // parser — but `1e39` is an ordinary `f64` that becomes infinity on the
        // way into an `f32` field, and arrives looking like a normal number.
        let raw =
            r#"{"type":"move_token","id":"t1","x":1e39,"y":0.0,"dragging":false,"staged":false}"#;
        let msg: ClientMsg = serde_json::from_str(raw).expect("this parses; that is the point");
        assert!(
            matches!(msg, ClientMsg::MoveToken { x, .. } if !x.is_finite()),
            "expected the narrowing to have produced infinity"
        );

        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        let before = state.tokens.get(&TokenId::new("t1")).expect("t1").x;

        state.handle(ClientId(1), msg);

        assert_eq!(
            state.tokens.get(&TokenId::new("t1")).expect("t1").x,
            before,
            "it got through"
        );
    }

    #[test]
    fn a_room_holding_a_non_finite_number_could_not_be_reloaded() {
        // The reason the check above exists, pinned so nobody relaxes it: this
        // is what would have been written to disk, and it does not come back.
        let json = serde_json::to_string(&f32::NAN).expect("encodes");
        assert_eq!(json, "null");
        assert!(
            serde_json::from_str::<f32>(&json).is_err(),
            "a saved NaN is unloadable"
        );
    }

    // --- persistence --------------------------------------------------------

    #[tokio::test]
    async fn shutdown_flushes_a_change_still_inside_the_debounce_window() {
        let path = std::env::temp_dir().join(format!(
            "slate-shutdown-test-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let room = spawn(SECRET.to_owned(), None, Store::new(path.clone()));
        let (out, mut replies) = mpsc::channel(CLIENT_MAILBOX);

        assert!(
            room.send(RoomCmd::Connected {
                client: ClientId(1),
                out,
            })
            .await
        );
        assert!(
            room.send(RoomCmd::Msg {
                client: ClientId(1),
                msg: ClientMsg::Hello {
                    dm_secret: Some(SECRET.to_owned()),
                    player_id: None,
                },
            })
            .await
        );
        assert!(matches!(
            replies.recv().await,
            Some(ServerMsg::Welcome { .. })
        ));

        assert!(
            room.send(RoomCmd::Msg {
                client: ClientId(1),
                msg: ClientMsg::MoveToken {
                    id: TokenId::new("t6"),
                    x: 9.2,
                    y: 11.8,
                    dragging: false,
                    staged: false,
                },
            })
            .await
        );

        // This happens immediately, well before the two-second debounce.
        assert!(room.shutdown().await);

        let loaded = Store::new(path.clone())
            .load()
            .await
            .expect("shutdown save loads")
            .expect("shutdown wrote a save");
        let ogre = loaded
            .tokens
            .iter()
            .find(|token| token.id == TokenId::new("t6"))
            .expect("the ogre was saved");
        assert_eq!((ogre.x, ogre.y), (9.5, 11.5));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_drag_frame_is_not_worth_saving_but_the_drop_is() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(1), "vex");

        let at = |dragging| ClientMsg::MoveToken {
            id: TokenId::new("t2"),
            x: 6.3,
            y: 5.1,
            dragging,
            staged: false,
        };

        assert!(
            !state.handle(ClientId(1), at(true)),
            "a drag frame must not hit the disk"
        );
        assert!(
            state.handle(ClientId(1), at(false)),
            "the drop is the position worth keeping"
        );
    }

    #[test]
    fn initiative_edits_are_worth_saving() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));

        let commands = [
            ClientMsg::SetInitiative {
                token: TokenId::new("t1"),
                value: 15,
            },
            ClientMsg::NextTurn,
            ClientMsg::PreviousTurn,
            ClientMsg::RemoveFromInitiative {
                token: TokenId::new("t1"),
            },
            ClientMsg::ClearInitiative,
        ];

        for cmd in commands {
            let description = format!("{cmd:?}");
            assert!(
                state.handle(ClientId(1), cmd),
                "{description} should be persisted"
            );
        }
    }

    #[test]
    fn a_refused_command_is_not_worth_saving() {
        let mut state = room();
        let _vex = join_as_player(&mut state, ClientId(1), "vex");

        let steal = ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: 1.5,
            y: 1.5,
            dragging: false,
            staged: false,
        };
        assert!(
            !state.handle(ClientId(1), steal),
            "nothing changed, so nothing to write"
        );
    }

    #[test]
    fn joining_is_not_worth_saving() {
        // Who is connected is not part of the room; it dies with the process.
        let mut state = room();
        let mut rx = connect(&mut state, ClientId(1));

        let hello = ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new("vex")),
        };
        assert!(!state.handle(ClientId(1), hello));
        assert!(
            matches!(rx.try_recv(), Ok(ServerMsg::Welcome { .. })),
            "still admitted"
        );
    }

    #[test]
    fn a_restored_room_is_the_room_that_was_saved() {
        let mut state = room();
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("t6"),
                x: 9.2,
                y: 11.8,
                dragging: false,
                staged: false,
            },
        );
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new("t6"),
                value: 17,
            },
        );
        state.handle(ClientId(1), ClientMsg::NextTurn);

        // Through JSON rather than straight through the structs: the file is the
        // contract, and a field that fails to serialize would pass otherwise.
        let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
        let saved: Saved = serde_json::from_slice(&json).expect("decodes");
        let restored = RoomState::restored(saved, SECRET.to_owned());

        assert_eq!(restored.tokens.len(), state.tokens.len());
        let ogre = restored
            .tokens
            .get(&TokenId::new("t6"))
            .expect("the ogre survived");
        assert_eq!(
            (ogre.x, ogre.y),
            (9.5, 11.5),
            "grid units, exactly as they were stored"
        );
        assert_eq!(ogre.owner, Owner::Dm);
        assert_eq!(ogre.name, "Ogre");

        assert_eq!(restored.initiative.current, Some(TokenId::new("t6")));
        assert_eq!(restored.initiative.entries.len(), 1);
        assert_eq!(restored.map.url, state.map.url);

        assert!(
            restored.clients.is_empty(),
            "nobody is connected to a room off disk"
        );
        assert_eq!(
            restored.roster.len(),
            5,
            "the roster comes from the build, not the file"
        );
    }

    #[test]
    fn a_restored_room_still_enforces_ownership() {
        // The point of persisting `owner`: a player who reconnects after a
        // restart gets their token back and no one else's.
        let mut state = RoomState::restored(room().to_saved(), SECRET.to_owned());
        let _vex = join_as_player(&mut state, ClientId(1), "vex");
        let client = state.clients.get(&ClientId(1)).expect("joined");

        assert!(can_move(
            client,
            state.tokens.get(&TokenId::new("t2")).expect("Vex's token")
        ));
        assert!(!can_move(
            client,
            state.tokens.get(&TokenId::new("t1")).expect("Grog's token")
        ));
        assert!(!can_move(
            client,
            state.tokens.get(&TokenId::new("t6")).expect("the ogre")
        ));
    }

    #[test]
    fn the_saved_token_order_is_stable() {
        // `HashMap` order varies per process, so without a sort the file would
        // come out differently on every save and diff against itself.
        let state = room();
        let ids: Vec<_> = state
            .to_saved()
            .tokens
            .iter()
            .map(|t| t.id.clone())
            .collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn snapshot_order_is_stable() {
        let state = room();
        let ids: Vec<_> = state
            .snapshot_for(&Identity::Dm)
            .tokens
            .iter()
            .map(|t| t.id.clone())
            .collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }
}

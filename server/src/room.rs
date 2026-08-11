//! The room actor.
//!
//! One `tokio` task exclusively owns `RoomState`. Nothing else can reach it, so
//! there are no locks on it and no `Arc<Mutex<_>>`. Commands arrive on one
//! `mpsc`; each client gets its own `mpsc` back — never a `broadcast`, because
//! `broadcast` hands every subscriber the same value and fog of war will need
//! different clients to receive different messages for one event.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until};
use tracing::{debug, error, warn};
use uuid::Uuid;

use crate::fog::{self, Cell, FogView, Override, OverrideView};
use crate::protocol::{
    Calibration, ClientId, ClientMsg, Diagonals, Hp, Initiative, InitiativeEntry, MapInfo, Origin,
    Owner, PlayerId, Pos, Px, RoomView, RosterEntry, RosterSlot, ServerMsg, Shape, ShapeId,
    ShapeKind, Token, TokenId, TokenView, Wall, WallId, WallKind,
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
///
/// `pub(crate)` for `fog.rs`, which clips what the party may explore to the same
/// box on a map with no play area. Two constants would be two answers to "how far
/// does the board go", and the fog's copy is the one that has to agree with the
/// walls' — otherwise a token dragged to cell one million reveals cells there,
/// and the packed rectangle spanning it is the whole map's worth of characters
/// per send.
pub(crate) const MAX_MAP_PX: f32 = 32768.0;

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
pub const MAX_SHAPE_CELLS: f32 = 30.0;

/// How many segments a map may hold. A traced dungeon is a couple of hundred, so
/// this is generous rather than tight — it is here to bound the save file and
/// the shadowcast fog will run against these, not to tell a DM when to stop.
const MAX_WALLS: usize = 2000;
/// Corners in one traced run. A DM who reaches this has been clicking for a
/// while without finishing; the run is an authoring convenience and splitting a
/// long one in two costs nothing.
const MAX_WALL_POINTS: usize = 256;

/// How many cells one override command may name.
///
/// A flood fill is legitimately thousands — a large dungeon room is a few
/// hundred, the whole traced level is a few thousand — so this is generous on
/// purpose. What it bounds is the fill that escapes through a gap the DM did not
/// notice and the client that sends a million cells for any other reason: the
/// frame is the cost, and the refusal names the size so the DM knows to fill a
/// smaller region rather than wondering what went wrong.
const MAX_OVERRIDE_CELLS: usize = 50_000;

/// The table, plus the DM, who holds no slot.
///
/// The id is a short slug rather than the name, because it is what
/// `localStorage` remembers and what a token's `owner` is written as — a name
/// with a space and a title in it makes both harder to read for no gain. The
/// two are independent: renaming a character is an edit here to the right-hand
/// column alone, and every token they own still points at them.
const ROSTER: [(&str, &str); 6] = [
    ("cleodara", "Cleodara"),
    ("saelyn", "Saelyn"),
    ("torrin", "Torrin"),
    ("bronzebeard", "Captain Bronzebeard"),
    ("fernbark", "Thornwhistle Fernbark"),
    ("ignacio", "Ignacio"),
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
    /// The board writes token names under them now, or it stopped. Payload-free
    /// like the ones below it, and the one of them that is rebuilt into the same
    /// answer for everybody — `FogChanged`'s shape rather than `WallsChanged`'s.
    NamesChanged,
    /// The ruler charges diagonals differently now. Payload-free and rebuilt into
    /// the same answer for everybody, exactly like the one above it.
    DiagonalsChanged,
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
    /// What the party can see changed — somebody moved, a door swung, a wall was
    /// traced, or the DM changed how far a torch reaches.
    ///
    /// Payload-free like the three above it, and the one of the four that is
    /// rebuilt per recipient into *the same answer*: fog is party-shared, so
    /// there is one of it. Everyone is sent it, the DM included, which is the
    /// opposite of `WallsChanged` sitting three lines up — the geometry is the
    /// secret, and the shadow it casts is the thing the table plays with.
    ///
    /// Never emitted from a drag frame. `moves_sight` is where that is decided,
    /// and it is the reason a party walking a corridor does not ship a bitset
    /// thirty times a second.
    FogChanged,
    /// The DM painted, filled, or cleared some cells of their manual override.
    ///
    /// Travels exactly as `WallsChanged` does and for the same reason: this is
    /// what the DM *decided*, and `FogChanged` beside it is what the table gets to
    /// see as a result. A player is not sent it, not even empty — a frame they
    /// cannot use still says the DM just did something, and here it would say
    /// *when*, on the one board they cannot see through.
    ///
    /// It is never the whole of the news. Painting a cell also moves the fog, so
    /// `refresh_fog` produces a `FogChanged` beside this one whenever anything the
    /// table can see actually changed.
    OverridesChanged,
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

/// What the fog looked like a moment ago, so `refresh_fog` can say what changed.
///
/// Both halves have to be read before `apply` runs, which is why they travel
/// together rather than being fetched where they are used: by the time the
/// recompute has happened, neither question can be asked of `&self` any more.
/// That is `was_unseen` on the token events, one layer out and for the same
/// reason — the difference between a monster that just walked out of the light
/// and one the party was never told about.
struct Sight {
    /// The frame the clients are currently holding, or `None` on an unfogged map.
    fog: Option<FogView>,
    /// Every token the table could see. Ids rather than a count: which ones is
    /// the whole question, and two tokens can trade places in the same step.
    seen: HashSet<TokenId>,
    /// Every shape the table could see, for the same reason and by the same
    /// measure.
    ///
    /// It could not be folded into `seen` above, because the two are answering
    /// different questions of different things — and it could not be left out at
    /// all once an *unanchored* shape started gating on `revealed`. Before that,
    /// a shape's visibility only ever moved when a token's did, so the token loop
    /// was enough to gate `ShapesChanged` on; now the fog opening onto ground
    /// somebody drew a circle on changes it with no token involved.
    shapes: HashSet<ShapeId>,
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
    /// Everywhere the party's own torches have ever reached, in grid cells.
    ///
    /// **The rays and nothing else.** No override ever writes here — that is what
    /// makes one removable, and 16b got it wrong: `Explored` and `Lit` used to be
    /// unioned in on every pass, so the cells stayed after the paint was cleared
    /// and a ground-fill was permanent. What the table is shown is `known` below,
    /// which is this with the mask applied.
    ///
    /// Persisted, and the only half of the fog that is: it is what the party
    /// remembers about the dungeon, and an evening of exploring belongs to the
    /// map it was done on. Cleared by `sweep_board` and by `ResetFog` — grid-space,
    /// so a new map is a new lattice and a recalibration invalidates it, which is
    /// exactly where this differs from the walls beside it.
    ///
    /// Grows and never shrinks within one map, short of those two. `fog.rs` clips
    /// what may go in it to the board, which is what stops a token dragged into
    /// the void from putting a cell a million squares away in here.
    revealed: HashSet<Cell>,
    /// What the table is shown as terrain: `revealed`, as the DM's mask leaves it.
    ///
    /// Derived and never persisted, exactly like `visible` below — the pair of
    /// them is one raycast plus one pass of the overrides, and `recompute_sight`
    /// builds both together. It is what `fog_for` packs and what an unanchored
    /// shape gates on; `revealed` itself is read by neither, and reading it
    /// instead is how a blacked-out room comes back onto the table's board.
    known: HashSet<Cell>,
    /// Where the party can see *now*. Derived, never persisted, and recomputed by
    /// `refresh_fog` rather than in the visibility filter — the filter runs
    /// against `&self` while the client map is borrowed, so it could not mutate
    /// this even if it wanted to, and it is better kept pure regardless.
    visible: HashSet<Cell>,
    /// What the DM has said about particular cells, overriding the rays.
    ///
    /// **A mask applied after the raycast, not a write into `revealed`**, and that
    /// is the whole reason it is its own state: a hide that merely cleared
    /// `revealed` would evaporate the next time somebody carried a torch past, and
    /// a reveal that merely wrote into it could never be taken back.
    ///
    /// The DM's authoring data, and it travels like the walls rather than like
    /// the fog — sent whole to the DM, never to a player, and clipped to the board
    /// before anything is stored. Persisted, unlike `visible`, because nothing in
    /// the room can derive what somebody decided.
    ///
    /// Cleared by `sweep_board` with `revealed`, and for the same reason: these
    /// are cells, so a new lattice invalidates them.
    overrides: HashMap<Cell, Override>,
    /// Whether the board writes each token's name under it.
    ///
    /// Room-wide, not per map and not per token. Per map would fork it between
    /// the two slots and reset it every time a dungeon was loaded, which is not
    /// what "label the board" means; per token would be six checkboxes to answer
    /// one question. It is the DM's to set and everyone's to hold — see
    /// `RoomView::show_names` for why this one is not filtered.
    show_names: bool,
    /// How the movement ruler charges a diagonal.
    ///
    /// The field above it in every respect that matters: room-wide, the DM's to
    /// set, everyone's to hold, filtered by nobody. **Nothing on this server
    /// reads it** — there is no movement distance in this crate — and that is
    /// not dead state: what the room owns is that six clients agree, which is
    /// exactly what it would not own if this lived in a browser.
    diagonals: Diagonals,
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
    let mut state = match saved {
        Some(saved) => RoomState::restored(saved, dm_secret),
        None => RoomState::hardcoded(dm_secret),
    };
    // `known` and `visible` are derived and neither is on disk, so a room that
    // has just booted holds neither and the first client to join would be told
    // the party can see nothing and remembers nothing — the whole dungeon dark on
    // a map they had explored. Done here rather than in the two constructors so
    // there is one place it can be forgotten instead of two.
    state.recompute_sight();

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
        // Two switches the DM flipped once and expects to find flipped next week.
        | Event::NamesChanged
        | Event::DiagonalsChanged
        | Event::InitiativeChanged
        | Event::MapChanged
        | Event::StagedChanged
        | Event::ShapesChanged
        // Half an hour of tracing. The one thing in the room where losing the
        // last two seconds of work would mean losing the segment the DM was
        // most likely to be in the middle of.
        | Event::WallsChanged
        // Only `revealed` is on disk, and only it can have grown here. Riding
        // along with the drop that caused it costs nothing — that frame already
        // marked the room dirty — and a session's exploration surviving a
        // restart is the difference between a map and a map with a memory.
        | Event::FogChanged
        // The walls' argument again: this is somebody's work, and nothing in the
        // room could reconstruct it from anything else if the file lost it.
        | Event::OverridesChanged => true,
        // A sketch is not in the room to be saved. It is the one thing here
        // that exists only between two pointer events, which is exactly why a
        // measuring line costs the disk nothing at all.
        Event::Sketching { .. } | Event::SketchEnded { .. } => false,
    }
}

/// Which commands could have changed what the party can see.
///
/// `persists`'s twin, and enumerated the same way rather than with a catch-all:
/// a command added later and forgotten here would leave the fog quietly stale,
/// which looks like a bug in the shadowcast rather than a missing arm. The two
/// lists ask different questions and mostly agree — the interesting disagreement
/// is `ShapesChanged`, which is worth a disk write and cannot occlude anything.
///
/// A drag frame is deliberately not one. The roadmap's rule is to recompute on
/// the drop: the raycast is cheap enough at 30 Hz and shipping a packed bitset to
/// six people that often is not, so the fog opens as a token settles rather than
/// as it travels. What still happens mid-drag is the *filter* — a monster dragged
/// into a cell the party cannot currently see stops being relayed to them at once,
/// because that decision reads `visible` rather than rebuilding it.
fn moves_sight(msg: &ClientMsg) -> bool {
    match msg {
        // A plan is a cell on a map the table has not been shown, and nothing on
        // the staged board casts a shadow on this one.
        ClientMsg::MoveToken {
            dragging, staged, ..
        } => !dragging && !staged,
        // Any of these can add, remove or re-own a vision source — handing a
        // token to a player is how somebody gains one — or move the lattice the
        // cells are counted on, or change what blocks a ray.
        ClientMsg::CreateToken { .. }
        | ClientMsg::UpdateToken { .. }
        | ClientMsg::DeleteToken { .. }
        | ClientMsg::SetMap { .. }
        | ClientMsg::PromoteStaged
        | ClientMsg::ClearStaged
        | ClientMsg::AddWalls { .. }
        | ClientMsg::RemoveWall { .. }
        | ClientMsg::ToggleDoor { .. }
        | ClientMsg::ClearWalls
        // These two are the only commands here that change what the party can see
        // without changing anything about the room they are looking at. The mask
        // is applied inside `recompute_sight`, so they need no arm of their own
        // anywhere else.
        | ClientMsg::SetFogOverride { .. }
        | ClientMsg::ResetFog => true,
        // Nothing drawn on the board occludes anything, a sketch is not in the
        // room at all, the turn order is a panel, and a label is written over
        // the light rather than in it.
        ClientMsg::Hello { .. }
        | ClientMsg::SetShowNames { .. }
        // A ruler is drawn over the light and never in it, and this only
        // changes what the ruler says.
        | ClientMsg::SetDiagonals { .. }
        | ClientMsg::Sketch { .. }
        | ClientMsg::AddShape { .. }
        | ClientMsg::RemoveShape { .. }
        | ClientMsg::ClearShapes
        | ClientMsg::SetInitiative { .. }
        | ClientMsg::RemoveFromInitiative { .. }
        | ClientMsg::ClearInitiative
        | ClientMsg::NextTurn
        | ClientMsg::PreviousTurn => false,
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
            revealed: fog::unpack(&saved.revealed),
            // Both derived from where the tokens are standing and what the DM
            // painted, all of which this same file holds — so they are recomputed
            // on boot rather than restored. That is what stops a save written
            // before a door was shut from describing sight through it.
            known: HashSet::new(),
            visible: HashSet::new(),
            // Restored whole, unlike the line above it. Sight is derived from
            // what this file already holds; what the DM decided is not derivable
            // from anything, so losing it would lose the work.
            overrides: fog::unpack_overrides(&saved.overrides),
            show_names: saved.show_names,
            diagonals: saved.diagonals,
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
            // Packed with an empty `visible`, so the file records explored
            // terrain and nothing about where anyone was standing when it was
            // written. Both lit states unpack as explored, so the two encodings
            // agree without either side having to know which one it is reading.
            revealed: fog::pack(&self.revealed, &HashSet::new()),
            overrides: fog::pack_overrides(&self.overrides),
            show_names: self.show_names,
            diagonals: self.diagonals,
            calibrations: self.calibrations.clone(),
        }
    }

    /// The room a first boot starts from, with no save on disk yet. Milestone 6
    /// replaces the map from the browser.
    fn hardcoded(dm_secret: String) -> Self {
        // The art is named separately rather than derived from the name: a
        // character called "Captain Bronzebeard" is a file called
        // `bronzebeard.png`, and these are stand-ins anyway — the real portraits
        // are picked out of the library onto whichever tokens end up being used.
        let party = |id: &'static str| Owner::Player(PlayerId::new(id));
        let specs: [(&str, &str, &str, f32, f32, Owner); 8] = [
            ("t1", "Cleodara", "cleodara", 3.5, 3.5, party("cleodara")),
            ("t2", "Saelyn", "saelyn", 4.5, 2.5, party("saelyn")),
            ("t3", "Torrin", "torrin", 13.5, 2.5, party("torrin")),
            (
                "t4",
                "Captain Bronzebeard",
                "bronzebeard",
                12.5,
                3.5,
                party("bronzebeard"),
            ),
            (
                "t5",
                "Thornwhistle Fernbark",
                "fernbark",
                5.5,
                4.5,
                party("fernbark"),
            ),
            // Not t6: the two monsters below were here first and the tests name
            // them by id, so the newest slot goes on the end rather than
            // renumbering the board out from under them.
            ("t8", "Ignacio", "ignacio", 6.5, 3.5, party("ignacio")),
            ("t6", "Ogre", "ogre", 14.5, 9.5, Owner::Dm),
            ("t7", "Wraith", "wraith", 21.5, 4.5, Owner::Dm),
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
                .map(|(id, name, art, x, y, owner)| {
                    let id = TokenId::new(id);
                    let token = Token {
                        id: id.clone(),
                        name: name.to_owned(),
                        x,
                        y,
                        owner,
                        img: format!("/assets/tokens/{art}.png"),
                        // The DM resizes anything that should be bigger. A
                        // first-boot room is a starting point, not a scene.
                        ..Token::default()
                    };
                    (id, token)
                })
                .collect(),
            shapes: Vec::new(),
            walls: Vec::new(),
            revealed: HashSet::new(),
            known: HashSet::new(),
            visible: HashSet::new(),
            overrides: HashMap::new(),
            // On, which is what the board did before there was a switch. A first
            // boot is a room with eight named tokens and nothing else to tell
            // them apart yet.
            show_names: true,
            // What the ruler did before there was a switch, which is the same
            // rule the line above follows to the opposite value.
            diagonals: Diagonals::Equal,
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

        // Read *before* `apply`, and only for the commands that could move it.
        //
        // Before, because the fog is what decides whether the table can see a
        // token, and `apply` plus the recompute that follows will have overwritten
        // both halves of that by the time anything asks. It is `was_unseen`'s
        // problem from milestone 11 one layer out: the question now spans the
        // whole command rather than one field on one token.
        //
        // Only for some commands, because this costs a set and a packed string,
        // and a drag frame arrives thirty times a second from each of six people.
        let before = moves_sight(&msg).then(|| self.sight_now());

        let mut events = self.apply(origin, msg);
        if let Some(before) = before {
            let more = self.refresh_fog(before, &events);
            events.extend(more);
        }
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
            .filter(|token| is_dm || !self.unseen_by_table(token))
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
            // The same value for everyone, unlike everything above it. Fog is
            // party-shared, so there is one answer; the DM is sent it so their
            // board can draw, faintly, what the table is looking at. It is the
            // walls one line up that stay theirs alone — a player reads the
            // geometry off the edges of this instead.
            fog: self.fog_for(),
            // And back to the walls' rule for the last field: this is what the DM
            // decided, and the line above is what the table gets to see of it.
            // Empty is both "nothing painted" and "you are not the DM".
            overrides: if is_dm {
                fog::pack_overrides(&self.overrides)
            } else {
                OverrideView::default()
            },
            // And back to `fog`'s rule for the last field, one line after the
            // walls': everyone is sent this, because the board being labelled the
            // same way for everybody is the whole of what it says.
            show_names: self.show_names,
            // And the same again, for the same reason. A counting convention
            // half the table holds is worse than either convention.
            diagonals: self.diagonals,
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
    fn shapes_for(&self, is_dm: bool) -> Vec<Shape> {
        self.shapes
            .iter()
            .filter(|shape| is_dm || self.shape_seen(shape))
            .cloned()
            .collect()
    }

    /// Whether the table may see this shape at all.
    ///
    /// Two arms, and they ask different questions on purpose. **An anchored shape
    /// follows its token's visibility** — an aura on a monster in the dark is that
    /// monster's position drawn in colour, and it goes wherever the monster goes.
    /// That arm shipped in milestone 14, because `hidden` predates fog and adding
    /// shapes without it would have been a leak the day it landed.
    ///
    /// **An unanchored shape is ground, so it gates on `known` rather than on
    /// `visible`.** A shape is painted on the floor and not standing on it: the
    /// marker a player dropped in a corridor is still theirs after they walk out
    /// of it, and gating on current sight would make every shape on the board
    /// flicker as the party moved. That is the same split `docs/fog.md` already
    /// draws between terrain and creatures, arriving for a third kind of thing.
    ///
    /// `known` and not `revealed`, so a circle drawn on ground the DM has painted
    /// over is treated the way that ground is — handed over with an `Explored`
    /// fill, and taken away again with a `Dark` one.
    ///
    /// The `map.fog` guard is load-bearing and not a shortcut: `known` is empty on
    /// an unfogged map, so without it every loose shape in the room would vanish
    /// from every player's board the moment fog was switched off.
    fn shape_seen(&self, shape: &Shape) -> bool {
        match &shape.from {
            Origin::Token(id) => self
                .tokens
                .get(id)
                .is_some_and(|t| !self.unseen_by_table(t)),
            Origin::Point(at) => {
                !self.map.fog || fog::shape_covers(shape.kind, *at, shape.to, &self.known)
            }
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
            self.tokens
                .get(token)
                .is_some_and(|t| self.unseen_by_table(t))
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

    /// **Whether the table cannot see this token — the one question every filter
    /// in this file asks.**
    ///
    /// `Token::unseen` used to be that question and is now half of it. Two of the
    /// three reasons are facts about the token and live there: `hidden` is a
    /// creature the DM took off the board, `staged_only` is one that was never on
    /// it. The third is a fact about the *room* — where the walls are, where the
    /// party is standing, how far their torches reach — so it cannot be answered
    /// from `&Token` alone, and that is the whole reason the funnel moved up here
    /// rather than growing a third field down there.
    ///
    /// All three compose and every filter has to ask about all three. Anything
    /// that asks `Token::unseen` directly is filtering on two of them, which is
    /// the leak this shape exists to make hard.
    fn unseen_by_table(&self, token: &Token) -> bool {
        token.unseen() || !self.in_sight(token)
    }

    /// Whether the party has line of sight on this token.
    ///
    /// A player's own token is always in sight, and by construction rather than
    /// by rule: it is a vision source, so the cell it stands in is lit by it.
    /// Saying so directly costs one branch and saves the DM handing a token over
    /// mid-fight from depending on the recompute having already run.
    ///
    /// A monster is in sight if *any* cell it covers is. A four-cell ogre leaning
    /// into a lit corridor is an ogre the party can see.
    fn in_sight(&self, token: &Token) -> bool {
        if !self.map.fog || matches!(token.owner, Owner::Player(_)) {
            return true;
        }
        fog::covered_cells(token.x, token.y, token.size)
            .iter()
            .any(|cell| self.visible.contains(cell))
    }

    /// Where the party is looking from, in image pixels.
    ///
    /// Vision comes from tokens a player *owns*, so handing one over grants sight
    /// with no extra rule and taking it back removes it. A player's token the DM
    /// has hidden grants none: it is off the board as far as the table is
    /// concerned, and a creature nobody can see lighting the room for everybody
    /// would be a strange thing to explain.
    ///
    /// Asked of `Token::unseen` and deliberately not of `unseen_by_table`, which
    /// would be circular — what the party can see cannot be an input to computing
    /// what the party can see.
    fn vision_sources(&self) -> Vec<Px> {
        let mut sources: Vec<Px> = self
            .tokens
            .values()
            .filter(|t| matches!(t.owner, Owner::Player(_)) && !t.unseen())
            .map(|t| fog::grid_to_px(&self.map, t.x, t.y))
            .collect();
        // `HashMap` order varies per process and the sweep short-circuits on
        // cells another source already lit. The answer is the same either way,
        // but two runs of the same room should do the same work.
        sources.sort_by(|a, b| {
            (a.x, a.y)
                .partial_cmp(&(b.x, b.y))
                .unwrap_or(Ordering::Equal)
        });
        sources
    }

    /// Recomputes line of sight and applies the DM's overrides over the top.
    ///
    /// Three sets come out of one raycast. **Only the rays reach `revealed`**, and
    /// the mask makes the other two:
    ///
    /// ```text
    /// revealed ∪= rays                          // memory, persisted, rays only
    /// visible   = rays  ∪ Lit − Dark            // in sight now
    /// known     = revealed ∪ Lit ∪ Explored − Dark   // what the table is shown
    /// ```
    ///
    /// **The order the old version agonised over is gone with the write it was
    /// protecting.** `Dark` had to leave `visible` before the union into
    /// `revealed` so a blacked-out cell could not enter the party's memory by the
    /// back door; now nothing but a ray enters memory at all, one `match` arm per
    /// cell settles both derived sets, and a cell can hold only one override, so
    /// there is no order left to get wrong.
    ///
    /// What that buys is the thing 16b claimed and did not do: **clearing a paint
    /// undoes it.** `Explored` used to be a one-way write, so a ground-fill was
    /// permanent, `Dark` really did destroy the memory under it, and the only way
    /// back was to reload the map.
    ///
    /// `visible ⊆ known` still holds — `revealed ⊇ rays`, and the mask does the
    /// same thing to both — which is what lets `FogView` pack both facts into one
    /// character per cell.
    ///
    /// Nothing downstream asks about an override: `in_sight` reads `visible` and
    /// gets a different answer, which is exactly what the roadmap asked for
    /// instead of a fourth question.
    ///
    /// An unfogged map has neither set and no mask: turning fog off is not the
    /// same as turning the lights on and leaving a stale bitset behind, and a map
    /// that gets fog turned back on should start from where the party is now. The
    /// overrides survive it — they are what the DM said, not a derived thing —
    /// and apply again the moment fog comes back.
    fn recompute_sight(&mut self) {
        if !self.map.fog {
            self.visible.clear();
            self.known.clear();
            return;
        }
        let rays = fog::visible_cells(&self.map, &self.walls, &self.vision_sources());

        self.revealed.extend(rays.iter().copied());
        self.known = self.revealed.clone();
        self.visible = rays;

        for (&cell, over) in &self.overrides {
            match over {
                Override::Lit => {
                    self.visible.insert(cell);
                    self.known.insert(cell);
                }
                Override::Explored => {
                    self.known.insert(cell);
                }
                Override::Dark => {
                    self.visible.remove(&cell);
                    self.known.remove(&cell);
                }
            }
        }
    }

    /// Forgets the dungeon: the party's memory and both sets derived from it.
    ///
    /// One call rather than three lines in three places, because the third set is
    /// exactly what gets missed the next time somebody adds one — and a `known`
    /// left standing after `revealed` is cleared is the entire map still sitting
    /// on the table's board.
    ///
    /// Emits nothing. Every caller is followed by `refresh_fog`, which compares
    /// against a reading taken before any of it, so the clear is already in the
    /// difference it reports.
    fn forget_fog(&mut self) {
        self.revealed.clear();
        self.known.clear();
        self.visible.clear();
    }

    /// The fog as it goes on the wire. `None` on a map with fog turned off, which
    /// is the only thing the server could mean by it — and, like `staged` being
    /// `None`, indistinguishable from the client side from a map that has none.
    fn fog_for(&self) -> Option<FogView> {
        self.map.fog.then(|| fog::pack(&self.known, &self.visible))
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

            // Nothing to bound: a bool has no bad value, and either state is a
            // legitimate thing for the DM to ask for — what is said of `hidden`
            // on a token and of `fog` on a map.
            ClientMsg::SetShowNames { .. } => require_dm(client, "label the board"),

            // Nothing to bound either: serde has already refused anything that
            // is not one of the two variants, which is what a closed set is for.
            ClientMsg::SetDiagonals { .. } => require_dm(client, "set how diagonals count"),

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
                fog: _,
                vision_ft,
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
                // `fog` needs no check — a bool has no bad value, and either
                // state is a legitimate thing for the DM to ask for, which is
                // exactly what is said of `hidden` on a token.
                //
                // The radius does. The sweep in `fog.rs` is quadratic in it, and
                // on a map with no play area to clip against this bound is the
                // only thing that stops the loop being unbounded.
                finite(&[*vision_ft])?;
                if !(fog::MIN_VISION_FT..=fog::MAX_VISION_FT).contains(vision_ft) {
                    return Err(format!(
                        "vision must be between {:.0} and {:.0} feet",
                        fog::MIN_VISION_FT,
                        fog::MAX_VISION_FT
                    ));
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
                        let seen = self.tokens.get(id).is_some_and(|t| {
                            client.identity == Identity::Dm || !self.unseen_by_table(t)
                        });
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

            ClientMsg::SetFogOverride { cells, .. } => {
                require_dm(client, "override the fog")?;
                // Refused rather than stored-and-ignored. An override on a map
                // with no fog can have no effect at all, and a command that
                // silently does nothing is worse than one that says why — the
                // panel greys itself for the same reason.
                if !self.map.fog {
                    return Err("there is no fog on this map to override".to_owned());
                }
                if cells.is_empty() {
                    return Err("that is no cells at all".to_owned());
                }
                // A fill can legitimately be a whole dungeon, so the cap is
                // generous. What it is actually here for is the fill that escapes
                // through a gap the DM did not notice and the client bug that
                // sends a million cells; either way, the frame is the cost.
                if cells.len() > MAX_OVERRIDE_CELLS {
                    return Err(format!(
                        "that is more than {MAX_OVERRIDE_CELLS} cells at once"
                    ));
                }
                // Clipped for the reason the sweep in `fog.rs` clips itself: a
                // cell a million squares out lands in the bounding box of the
                // packed rectangle, and the box spanning it and the dungeon is
                // the whole map's worth of characters on every send.
                if cells.iter().any(|&c| !fog::cell_on_board(&self.map, c)) {
                    return Err("that is not on the board".to_owned());
                }
                Ok(())
            }
            ClientMsg::ResetFog => require_dm(client, "reset the fog"),

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
                // Read through `unseen_by_table`, which needs `&self`, so it has
                // to happen before the mutable borrow below rather than beside
                // the fields it describes. Asking `Token::unseen` here instead —
                // which is what this line said before fog existed — makes
                // renaming a monster that is standing in the dark send the table
                // a `TokenRemoved` for an id they have never held.
                let was_unseen = self
                    .tokens
                    .get(&id)
                    .is_some_and(|t| self.unseen_by_table(t));

                let Some(token) = self.tokens.get_mut(&id) else {
                    return Vec::new(); // proved to exist by `check`
                };

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

            // Emitted whether or not it changed anything, like `ClearWalls` next
            // to it: a frame that says what the room already said is a no-op on
            // arrival, and a comparison here would be a second place the answer
            // is decided.
            ClientMsg::SetShowNames { show } => {
                self.show_names = show;
                vec![Event::NamesChanged]
            }

            // Unconditional for the reason above it, and this one has a second:
            // a client that missed a frame has no way to ask, so a redundant
            // send is the cheapest resync there is.
            ClientMsg::SetDiagonals { diagonals } => {
                self.diagonals = diagonals;
                vec![Event::DiagonalsChanged]
            }

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
                fog,
                vision_ft,
                staged,
            } => {
                let given = Calibration {
                    grid_px,
                    offset_x,
                    offset_y,
                    grid_color,
                    play_area,
                    fog,
                    vision_ft,
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
                    // The fourth thing that turns on `loading`, and the only one
                    // that also turns on a recalibration. The explored cells are
                    // grid-space, so the lattice moving under them is enough on
                    // its own — a DM who nudges the offset by half a cell has not
                    // changed which rooms the party has been in, but they have
                    // changed which squares those rooms are made of, and there is
                    // no honest way to carry the old answer across. Redrawing the
                    // play area is the same act at board scale: what was explored
                    // outside the new edge is not somewhere the party can be.
                    //
                    // Asked of the board's shape alone, and that is the point:
                    // turning the vision radius up is not a reason for the party
                    // to forget the dungeon, and neither is the grid's colour or
                    // turning fog off and on again.
                    let reshaped = (
                        self.map.grid_px,
                        self.map.offset_x,
                        self.map.offset_y,
                        self.map.play_area,
                    ) != (
                        finished.grid_px,
                        finished.offset_x,
                        finished.offset_y,
                        finished.play_area,
                    );

                    // Deliberately not cleared here. A plan describes a cell on
                    // the staged map, which this command has not touched — the
                    // plans are still about the map they were made on.
                    self.map = finished;
                    let mut events = vec![Event::MapChanged];
                    if reshaped {
                        self.forget_fog();
                        // And the DM's overrides, by the identical argument: they
                        // are cells, and the squares they name have just moved
                        // out from under them. This one needs its own event —
                        // nothing recomputes it, so the DM's panel would go on
                        // drawing a mask the room no longer holds.
                        if !self.overrides.is_empty() {
                            self.overrides.clear();
                            events.push(Event::OverridesChanged);
                        }
                    }
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

            ClientMsg::SetFogOverride { cells, state } => {
                match state {
                    // `Auto` is the absence of an entry rather than a fourth
                    // variant, so handing cells back to the rays is a removal.
                    // One representation of "not overridden", which is what keeps
                    // `recompute_sight` from having a case that does nothing.
                    None => {
                        for cell in cells {
                            self.overrides.remove(&cell);
                        }
                    }
                    Some(state) => {
                        for cell in cells {
                            self.overrides.insert(cell, state);
                        }
                    }
                }
                // The fog moving is `refresh_fog`'s to report, not this arm's.
                // It runs against a reading taken before `apply`, so whatever the
                // mask did to the two sets is already in the difference — and if
                // the DM painted `Dark` over cells nobody could see anyway, there
                // is correctly no `FogChanged` at all.
                vec![Event::OverridesChanged]
            }

            // The whole map back to dark, and then whatever the party can see
            // from where they are standing. `sweep_board` without the board: the
            // same three sets and the same mask, minus the shapes and the walls,
            // because this is the fog starting over and not the map.
            ClientMsg::ResetFog => {
                self.forget_fog();
                self.overrides.clear();
                vec![Event::OverridesChanged]
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

    /// Everything about the fog that a command might change, read before it runs.
    fn sight_now(&self) -> Sight {
        Sight {
            fog: self.fog_for(),
            seen: self
                .tokens
                .values()
                .filter(|t| !self.unseen_by_table(t))
                .map(|t| t.id.clone())
                .collect(),
            shapes: self
                .shapes
                .iter()
                .filter(|s| self.shape_seen(s))
                .map(|s| s.id.clone())
                .collect(),
        }
    }

    /// Recomputes sight and says what changed, as events.
    ///
    /// This is the milestone in one function. Three things can fall out of a
    /// party taking one step, and only the first is the fog itself:
    ///
    /// - the fog frame, if what is lit or explored is not what it was;
    /// - a token appearing or vanishing for the table, because the cells it
    ///   stands on just changed state. The player who walked into the room has
    ///   never held the ogre in it, so `was_unseen` is true and `message_for`
    ///   turns the same event into a whole token for them and a `TokenRemoved`
    ///   for the reverse. That machinery is milestone 11's and is reused whole;
    /// - the panels that name those tokens. A creature the table cannot see must
    ///   not be a row in their initiative list or an aura on their board, which
    ///   is the same pair of gates hiding a monster already goes through.
    ///
    /// Both of the last two are gated on something actually having changed, and
    /// that is load-bearing rather than tidy for the third time in this file: an
    /// unconditional `ShapesChanged` on every step would tell the table that
    /// *something happened* every time anybody moved.
    fn refresh_fog(&mut self, before: Sight, already: &[Event]) -> Vec<Event> {
        self.recompute_sight();

        let mut events = Vec::new();
        if self.fog_for() != before.fog {
            events.push(Event::FogChanged);
        }

        // A token the command has already spoken about is not spoken about
        // again. Each of those events carries its own `was_unseen`, read through
        // the same question this one asks, so the transition has been announced
        // correctly once already and a second frame would only repeat it.
        //
        // `TokenMoved` is deliberately not in that list, and it is the
        // interesting exclusion: walking out of the light is *how* a creature
        // stops being visible, and the move frame for it has just been dropped
        // for exactly the recipients who now need to be told it is gone.
        let spoken: HashSet<&TokenId> = already
            .iter()
            .filter_map(|event| match event {
                Event::TokenChanged { id, .. }
                | Event::TokenRemoved { id, .. }
                | Event::TokenPlanChanged { id }
                | Event::Promoted { id, .. } => Some(id),
                Event::TokenMoved { .. }
                | Event::NamesChanged
                | Event::DiagonalsChanged
                | Event::InitiativeChanged
                | Event::MapChanged
                | Event::StagedChanged
                | Event::Sketching { .. }
                | Event::SketchEnded { .. }
                | Event::ShapesChanged
                | Event::WallsChanged
                | Event::FogChanged
                | Event::OverridesChanged => None,
            })
            .collect();

        // Sorted, for the reason every other batch in this file is: `HashMap`
        // order varies per process and decides the order of the frames six
        // clients receive.
        let mut flipped: Vec<TokenId> = self
            .tokens
            .values()
            .filter(|t| !spoken.contains(&t.id))
            .filter(|t| before.seen.contains(&t.id) == self.unseen_by_table(t))
            .map(|t| t.id.clone())
            .collect();
        flipped.sort();

        let mut initiative = false;
        let mut shapes = false;
        for id in flipped {
            initiative |= self.initiative.index_of(&id).is_some();
            shapes |= self.anchors_a_shape(&id);
            let was_unseen = !before.seen.contains(&id);
            events.push(Event::TokenChanged { id, was_unseen });
        }
        if initiative {
            events.push(Event::InitiativeChanged);
        }
        // The token loop above catches every *anchored* shape, since one of those
        // is visible exactly when its token is. An unanchored one gates on
        // `revealed` instead, so the fog opening onto ground somebody drew a
        // circle on changes it with no token involved — and that is what this
        // second reading is for. Still one gate and still one event: an
        // unconditional `ShapesChanged` on every step would tell the table that
        // *something happened* every time anybody moved.
        shapes |= self
            .shapes
            .iter()
            .any(|s| before.shapes.contains(&s.id) != self.shape_seen(s));
        if shapes {
            events.push(Event::ShapesChanged);
        }
        events
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
        // And the explored terrain, which is where the fog differs from the walls
        // it was just cleared beside. A wall survives a recalibration because it
        // is in image pixels and still traces the same painted line; these are
        // cells, so the lattice moving underneath them is enough to invalidate
        // them and a new image certainly is.
        //
        // No event of its own: `refresh_fog` runs after this on the way out of
        // `handle`, and it compares against a reading taken before any of it, so
        // the clear is already in the difference it reports. Emitting one here
        // would be the same news twice.
        self.forget_fog();
        // The DM's overrides go with them, and this one *does* need its own
        // event: it is authoring data rather than a derived set, so nothing
        // recomputes it and the DM's own panel would go on drawing cells the room
        // no longer holds. Gated like the two above, for the reason those are.
        if !self.overrides.is_empty() {
            self.overrides.clear();
            events.push(Event::OverridesChanged);
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
        // Before the removal, and through `unseen_by_table` rather than
        // `Token::unseen`: whether the table is owed the news depends on whether
        // they could see it, and a monster standing in the dark is one they were
        // never told about. Once it is out of the room neither question can be
        // asked at all.
        let was_unseen = self.tokens.get(id).is_some_and(|t| self.unseen_by_table(t));

        if self.tokens.remove(id).is_none() {
            return Vec::new();
        }

        let mut events = vec![Event::TokenRemoved {
            id: id.clone(),
            was_unseen,
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

        // Read for every token before any of them is touched, and through
        // `unseen_by_table`: a promote sweeps the board's fog, so by the time the
        // loop below runs the question would be being asked of a lattice that has
        // already been thrown away.
        let was_unseen: HashMap<TokenId, bool> = ids
            .iter()
            .filter_map(|id| self.tokens.get(id))
            .map(|t| (t.id.clone(), self.unseen_by_table(t)))
            .collect();

        ids.into_iter()
            .filter_map(|id| {
                let was_unseen = was_unseen.get(&id).copied().unwrap_or(true);
                let token = self.tokens.get_mut(&id)?;
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
                    if self.tokens.get(id).is_some_and(|t| self.unseen_by_table(t)) {
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

                if is_dm || !self.unseen_by_table(token) {
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
                // Still out of the table's reach — the DM also took this one off
                // the board, or its plan landed it somewhere they have no line of
                // sight on. The second of those is new with fog and is why this
                // is not simply `None`: a token they were watching a moment ago
                // has to be taken off their board rather than left standing at
                // the cell it used to be in, on a map that is no longer there.
                if self.unseen_by_table(token) {
                    return (!*was_unseen).then(|| ServerMsg::TokenRemoved { id: id.clone() });
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

            // Everyone, unfiltered, and echoed to the DM for the reason above —
            // their checkbox settles on this frame rather than on their click.
            // The DM decides it and the table is told, which is `FogChanged`'s
            // shape: the switch is theirs, the labelling is the board's.
            Event::NamesChanged => Some(ServerMsg::NamesChanged {
                show: self.show_names,
            }),

            // The same again, and the sharpest example of the rule: the server
            // never counts a diagonal, so the only thing it is authoritative
            // over here is that everybody counts them the same way.
            Event::DiagonalsChanged => Some(ServerMsg::DiagonalsChanged {
                diagonals: self.diagonals,
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

            // The one arm here that builds the same thing for everybody. Fog is
            // party-shared, so there is one answer and no filtering left to do —
            // this is the frame the walls above are withheld *in favour of*.
            Event::FogChanged => Some(ServerMsg::FogChanged {
                fog: self.fog_for(),
            }),

            // And straight back to the walls' rule, one line below the one arm
            // that does not filter. The pair is the whole design in two lines:
            // what the DM decided reaches the DM, and the difference it made
            // reaches the table.
            Event::OverridesChanged => self.is_dm(recipient).then(|| ServerMsg::OverridesChanged {
                overrides: fog::pack_overrides(&self.overrides),
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
mod tests;

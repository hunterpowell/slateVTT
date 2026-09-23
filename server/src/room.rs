//! The room actor.
//!
//! One `tokio` task exclusively owns `RoomState`. Nothing else can reach it, so
//! there are no locks on it and no `Arc<Mutex<_>>`. Commands arrive on one
//! `mpsc`; each client gets its own `mpsc` back. Never use a `broadcast`:
//! it hands every subscriber the same value, and fog of war needs different
//! clients to receive different messages for one event.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until};
use tracing::{debug, error, warn};
use uuid::Uuid;

use crate::fog::{self, Cell, FogView, Override, OverrideView};
use crate::protocol::{
    Calibration, ChatLine, ChatTo, ClientId, ClientMsg, Colours, Diagonals, GridShape, Hp,
    Initiative, InitiativeEntry, MapInfo, Marker, Origin, Owner, PALETTE, PlayerId, Pos, Prepared,
    RoomView, RosterEntry, RosterSlot, ServerMsg, Shape, ShapeId, ShapeKind, StagedView, Token,
    TokenId, TokenView, Wall, WallId, WallKind,
};
use crate::store::{Saved, SavedNote, Store};

/// Per-client outbound buffer. Six clients at ~30 Hz never approach this; if a
/// client does fill it, its socket is wedged and it gets dropped.
pub const CLIENT_MAILBOX: usize = 256;
const ROOM_MAILBOX: usize = 128;

/// How long a change may sit unsaved. Long enough that a DM placing six
/// monsters writes the file once instead of six times; short enough that a
/// power cut costs a move, not an evening.
const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);

/// How many undos the DM can take. The ring holds one more than this: the
/// state they are in now, plus this many to go back to.
///
/// Ten because a snapshot is the whole persisted room and the ring is held in
/// memory, and because undo is for the mistake you just noticed, not the one
/// you made before dinner. One step per command means a long wall trace fills
/// it. That's expected, not a defect to design around: the way out of a bad
/// trace is `ClearWalls`, which is itself one undoable step.
const MAX_UNDO: usize = 10;

/// Bounds on a calibrated grid. The client draws one overlay line per cell, so
/// a two-pixel grid on a large map is hundreds of thousands of lines per frame
/// and a locked-up browser.
const MIN_GRID_PX: f32 = 4.0;
const MAX_GRID_PX: f32 = 4096.0;
/// How far from square an isometric diamond may be: its width over its height.
///
/// Bounded for the same reason as `grid_px`. The width is `grid_px * ratio`,
/// so without this a legal `grid_px` and an absurd ratio would put a cell
/// outside the range the bound above keeps it inside. `2.0` is the common
/// projection and sits comfortably within these.
const MIN_GRID_RATIO: f32 = 0.25;
const MAX_GRID_RATIO: f32 = 4.0;
/// Comfortably longer than anything the upload endpoint generates, short enough
/// that nobody can grow the save file through this field.
const MAX_URL_LEN: usize = 512;
/// Larger than any real map image, and small enough that the client cannot be
/// asked to rule an unbounded number of grid lines.
///
/// `pub(crate)` for `fog.rs`, which clips what the party may explore to the same
/// box on a map with no play area. Don't give the fog its own constant: it has
/// to agree with the walls' bound. Otherwise a token dragged to cell one million
/// reveals cells there, and the packed rectangle spanning it is the whole map's
/// worth of characters per send.
pub(crate) const MAX_MAP_PX: f32 = 32768.0;

/// Long enough for "Goblin Archer (bloodied)", short enough that the label
/// drawn under the token stays a label.
const MAX_TOKEN_NAME_LEN: usize = 48;
/// The sizes a token may be, in grid cells. A closed set because the snapping
/// rule is defined per size, and because a dropdown of five entries is a better
/// answer to "how big is it" than a number field.
///
/// The half is for a druid who is currently a rat. It snaps like a single-cell
/// token and is drawn smaller. See `snap_to_cell`.
const TOKEN_SIZES: [f32; 5] = [0.5, 1.0, 2.0, 3.0, 4.0];
/// Bounds the save file, and is far past a battle anyone runs. A DM who hits
/// this has a room that needs clearing out.
const MAX_TOKENS: usize = 200;
/// How far a hit point total may run in either direction. Negative is allowed
/// because a DM tracking how far past zero something went is bookkeeping, not
/// a rule. This only stops the save file growing through a number field.
const MAX_HP: i32 = 9999;

/// Bounds the save file the way `MAX_TOKENS` does. Well past what a fight puts
/// on the board, and low enough that a board nobody has cleared in a month is
/// still a board the client can draw.
const MAX_SHAPES: usize = 64;
/// How far a shape may reach from its origin, in cells (150 feet).
///
/// The same failure as `MIN_GRID_PX`: an area shape tints every cell it covers,
/// so the client walks the cells inside its bounding box. A circle a million
/// cells across is a frozen browser on five other machines, and a sketch
/// reaches them before anybody has decided to keep it.
pub const MAX_SHAPE_CELLS: f32 = 30.0;

/// How many segments a map may hold. A traced dungeon is a couple of hundred, so
/// this is generous. It bounds the save file and the fog raycast that runs
/// against these; it isn't meant to tell a DM when to stop.
const MAX_WALLS: usize = 2000;
/// Corners in one traced run. A DM who reaches this has been clicking for a
/// while without finishing; the run is an authoring convenience and splitting a
/// long one in two costs nothing.
const MAX_WALL_POINTS: usize = 256;

/// How many cells one override command may name.
///
/// A flood fill is legitimately thousands (a large dungeon room is a few
/// hundred, the whole traced level is a few thousand, and a 4000×3000 map at
/// 50 px to the cell is 80×60), so this is generous. What it bounds is the fill
/// that escapes through a gap the DM didn't notice, and a client that sends a
/// million cells for any other reason. The frame is the cost, and the refusal
/// names the size so the DM knows to fill a smaller region.
///
/// **The refusal only reaches the DM if this number fits inside
/// `MAX_WS_MESSAGE_BYTES`.** `cells` is a `Vec<Cell>` and a `Cell` is a tuple,
/// so the command carries `[x,y]` per cell: up to 12 bytes with the comma at
/// four-digit coordinates. 8,000 of them is ~94 KiB inside a 128 KiB frame.
/// A frame over the cap kills the socket on the read and reloads the DM's page,
/// so the check below never runs.
/// `fog_of_war::largest_override_fits_in_a_frame` keeps the two in step, and
/// `MAX_FILL_CELLS` in `fogtool.ts` mirrors this. See `docs/net.md`.
const MAX_OVERRIDE_CELLS: usize = 8_000;

/// How much of a session's talk the room keeps.
///
/// A cap, not a retention policy: the log is trimmed from the front so a
/// browser hiccup mid-combat doesn't lose the initiative rolls somebody posted
/// a minute ago. The log is memory only, so this bounds a `VecDeque`, not a
/// file, and 200 lines is an evening of six people calling out numbers.
const MAX_CHAT_LINES: usize = 200;
/// How long one message may be. A generous sentence: this is a table talking,
/// not a journal, and the box is one line high.
const MAX_CHAT_LEN: usize = 400;

/// The dice in the bag.
///
/// A closed set, like `TOKEN_SIZES`: seven buttons is a better answer to
/// "which die" than a number field, and nobody owns a d7.
const DICE_SIDES: [u8; 7] = [4, 6, 8, 10, 12, 20, 100];
/// How many of one die may be thrown at once.
///
/// A fireball is 8d6 and a disintegrate is 12d6, so this is generous. It keeps
/// the formatted line inside `MAX_CHAT_LEN`; it isn't meant to tell a table
/// when to stop. That's the two-bounds rule: the count the room refuses past,
/// and the bytes the line has to fit.
/// `dice::the_largest_roll_fits_a_chat_line` keeps the pair in step.
const MAX_DICE: u8 = 20;

/// How much one person may keep in their scratchpad.
///
/// Four pages, which is far past what a box for "the innkeeper is called Doran"
/// is for and far short of anything that troubles a save file on a Raspberry Pi.
/// The client's textarea carries the same number as its `maxlength`, so typing
/// stops at the limit. This is the backstop for a client that doesn't, like
/// every other cap in this file.
const MAX_NOTES_LEN: usize = 10_000;

/// The table, plus the DM, who holds no slot.
///
/// The id is a short slug, not the name, because it's what `localStorage`
/// remembers and what a token's `owner` is written as, and a name with a space
/// and a title in it makes both harder to read. The two are independent:
/// renaming a character edits only the right-hand column here, and every token
/// they own still points at them.
const ROSTER: [(&str, &str); 6] = [
    ("cleodara", "Cleodara"),
    ("saelyn", "Saelyn"),
    ("torrin", "Torrin"),
    ("bronzebeard", "Captain Bronzebeard"),
    ("fernbark", "Thornwhistle Fernbark"),
    ("ignacio", "Ignacio"),
];

/// The cast of the Halloween one-shot.
///
/// A separate array, not a second column on the one above, because the two
/// casts are independent: a different length, and no slug in common unless one
/// is written twice on purpose. A player who plays in both rooms holds two
/// slugs, which keeps their tokens, colour and scratchpad separate in each.
const HALLOWEEN_ROSTER: [(&str, &str); 6] = [
    ("elias", "Elias"),
    ("corvus", "Corvus Nevermore"),
    ("rostam", "Rostam"),
    ("ironbeak", "Iron Beak"),
    ("baron", "Baron"),
    ("player-6", "Player 6"),
];

/// The map a room that has never been given one stands on.
///
/// Shipped in `client/assets`, so it is there on a fresh checkout with no
/// library and no uploads. Both `hardcoded` and `blank` start here and the DM's
/// first map load replaces it.
const BUILT_IN_MAP: &str = "/assets/map.png";

/// One room on this server: a board, a save file and a cast of its own.
///
/// **Don't change an id after the room has been played in.** It names the save
/// file on disk, the `localStorage` key a player's claimed slot is remembered
/// under, and the `?room=` a link carries, so changing it orphans all three. It
/// is a slug for the same reason a roster id is, and a test below checks it,
/// because a room id with a slash in it would be a path.
struct RoomDef {
    id: &'static str,
    /// What the room picker shows. Free text, and the only field here nothing
    /// is keyed on, so renaming a campaign is safe at any point.
    name: &'static str,
    /// A slice, not a fixed array, so two casts may differ in size.
    roster: &'static [(&'static str, &'static str)],
}

/// Every room, fixed at boot.
///
/// A const, not a registry: the rooms are known before the first socket opens,
/// so `AppState` holds a map that is built once and only read after that. Don't
/// add an `RwLock<HashMap<..>>`: a lock guards a table that changes, and nothing
/// changes this one. Adding a campaign is an edit to this array and a redeploy,
/// the same as editing a roster.
///
/// The first entry is the primary room. Two things follow from that and nothing
/// else does: its save file is `SLATE_STATE` as given, not a sibling named after
/// its id, and a fresh checkout boots it into `RoomState::hardcoded`, not an
/// empty board. Both keep the single-room server's behaviour for that room, so
/// neither applies to any other room.
const ROOMS: [RoomDef; 2] = [
    RoomDef {
        id: "campaign",
        name: "Campaign",
        roster: &ROSTER,
    },
    RoomDef {
        id: "halloween",
        name: "Halloween One-Shot",
        roster: &HALLOWEEN_ROSTER,
    },
];

/// The rooms, in the order the picker shows them.
pub fn rooms() -> impl Iterator<Item = (&'static str, &'static str)> {
    ROOMS.iter().map(|def| (def.id, def.name))
}

/// The cast of one room, or `None` if there is no such room.
///
/// The lookup every caller outside this module wants: `main.rs` spawns a room
/// per id and has no business holding a `RoomDef`.
pub fn roster_of(id: &str) -> Option<Vec<RosterEntry>> {
    ROOMS
        .iter()
        .find(|def| def.id == id)
        .map(|def| roster_from(def.roster))
}

/// Whether this room is the one the single-room server became. See `ROOMS`.
pub fn is_primary(id: &str) -> bool {
    ROOMS.first().is_some_and(|def| def.id == id)
}

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
    /// Report how the room is doing, for `/api/status`. The only command that
    /// asks the room a question and changes nothing.
    ///
    /// It goes through the same `mpsc` as every socket's traffic. A status
    /// answered anywhere else couldn't see the room, and a slow reply through
    /// the queue is how a wedged actor shows up. The caller's timeout catches
    /// that.
    Status {
        done: oneshot::Sender<RoomStatus>,
    },
}

/// One room, as the status page sees it.
///
/// Kept small. This is an ops window, not a second board: it answers "is the
/// room alive, is anyone in it, is anything unwritten". Questions about play
/// (whose turn it is, which map is up) belong on the board, where the answer
/// can be acted on.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RoomStatus {
    /// Straight from `RoomState::here`: the same answer `ServerMsg::Presence`
    /// carries, deduplicated and DM-first.
    pub here: Vec<Owner>,
    /// Sockets, not people, which is the one thing `here` can't say: a table
    /// of three with five tabs open is worth being able to see.
    pub sockets: usize,
    pub tokens: usize,
    /// Whether a change is sitting inside the save debounce. That lives in
    /// `run`, not on `RoomState`, which is why this struct is finished there.
    pub unsaved: bool,
    /// Whether the last write to disk *failed*. **This must stay separate from
    /// `unsaved`**: a save that keeps failing leaves `save_at` set just as a
    /// change waiting out the debounce does, so on the deadline alone a dying
    /// SD card looks the same as a healthy write two seconds old. This is the
    /// field that means the group is about to lose an evening.
    pub saves_failing: bool,
    /// When the room was last written to disk successfully, or `None` if it
    /// hasn't been since this process started. A quiet room may never write,
    /// so that isn't a problem on its own. It says how much is at risk once
    /// `saves_failing` is set.
    pub last_saved_unix: Option<u64>,
}

/// How a room's writes to disk are going.
///
/// Lives in `run` beside `save_at`, because that's where `flush` is called
/// from, and it tells what the deadline can't: whether the writes succeed.
#[derive(Debug, Default)]
struct SaveHealth {
    failing: bool,
    last_ok_unix: Option<u64>,
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

    /// How the room is doing, or `None` if it did not answer.
    ///
    /// Shaped like `shutdown`, with one difference: **the caller must put a
    /// timeout on this.** A room whose task is wedged never drains its mailbox,
    /// so this future never completes, and the moment a status page most needs
    /// an answer is the moment it would hang waiting for one. `None` means "did
    /// not answer", which is itself a status.
    pub async fn status(&self) -> Option<RoomStatus> {
        let (done, reply) = oneshot::channel();
        if self.tx.send(RoomCmd::Status { done }).await.is_ok() {
            return reply.await.ok();
        }
        None
    }
}

/// Internal, and kept separate from `ServerMsg`. They are nearly 1:1, but
/// keeping them apart lets one event become a different message per recipient.
#[derive(Debug, Clone)]
enum Event {
    TokenMoved {
        id: TokenId,
        x: f32,
        y: f32,
        dragging: bool,
        /// The token's plan for the staged map, not its position. Reaches only
        /// the DM, because only the DM holds that field.
        staged: bool,
    },
    /// A token was created or edited. Carries only the id, so `message_for`
    /// reads the token off `&self` per recipient. That's how one event becomes
    /// a `TokenRemoved` for the players and a `TokenChanged` for the DM when
    /// the token is hidden.
    TokenChanged {
        id: TokenId,
        /// Whether the table could see this token *before* the change.
        /// `message_for` can't read it off `&self`, because `apply` has already
        /// overwritten it, and it separates "it just vanished" from "you were
        /// never told it was there".
        ///
        /// "Unseen", not "hidden": a token built on the next map is just as
        /// absent from the table's board and goes through the same three arms.
        /// See `Token::unseen`.
        ///
        /// A token that has just been created counts as unseen: nobody holds it
        /// yet, so a create that lands out of sight is nothing to announce.
        was_unseen: bool,
    },
    TokenRemoved {
        id: TokenId,
        /// Same reason: `apply` has already taken the token out of the room, so
        /// whether the table knew it existed can't be looked up any more. A
        /// player who was never told it was there isn't told it's gone, because
        /// that frame would name an id they shouldn't hold.
        was_unseen: bool,
    },
    /// Only the DM-only part of a token changed: its plan for the staged map,
    /// which the table can't observe either way.
    ///
    /// Filtered by who the recipient is, like `StagedChanged`, not by anything
    /// anyone did. That's why this isn't `TokenChanged`: a player's copy of the
    /// token is byte-identical before and after, so a frame for them would carry
    /// no data and still show anyone with devtools open the moment the DM threw
    /// a plan away. Invariant 4 covers what a client may know, and *that
    /// something happened* is something to know.
    TokenPlanChanged { id: TokenId },
    /// A promote applied this token's plan: it came into existence on the board,
    /// or it moved, or both.
    ///
    /// Its own variant because it leaves in three different shapes at once: a
    /// full token for the DM, whose staged fields have just been emptied and who
    /// can't learn that from a `TokenMoved`; a creation for a player seeing it
    /// for the first time; and a plain move for a player who could already see
    /// it.
    Promoted {
        id: TokenId,
        /// As above, read before `apply` cleared `staged_only`.
        was_unseen: bool,
        /// Its live position changed, meaning it had a plan. False for a token
        /// that only came into existence where it already stood.
        moved: bool,
    },
    /// The board now writes token names under them, or stopped. Payload-free,
    /// like the room-wide settings below, and rebuilt into the same answer for
    /// everybody (the `FogChanged` pattern, not the `WallsChanged` one).
    NamesChanged,
    /// The ruler now counts diagonals differently. Payload-free and the same for
    /// everybody, like `NamesChanged`.
    DiagonalsChanged,
    /// Pointers are now drawn on every board, or aren't. Same as the two above,
    /// including that the frame reaches the DM who flipped it.
    CursorsChanged,
    /// The DM's pointer is now drawn on the players' boards, or isn't. Same as
    /// the ones above.
    DmCursorChanged,
    /// There is now a picture in front of the table, or there isn't. Same as
    /// the ones above, including that the frame reaches the DM who put it up.
    BackdropChanged,
    /// The room is now playing a track, or isn't. On the wire it's the same as
    /// the ones above. The difference is that this is the only one of them
    /// that isn't saved.
    AudioChanged,
    /// Carries no payload: `message_for` has `&self` and builds the panel per
    /// recipient, which is how the row of a creature the table can't see is
    /// dropped from the table's copy.
    InitiativeChanged,
    /// A new image, a recalibrated grid, or both. Payload-free for the same
    /// reason as above: terrain is filtered by fog of war.
    MapChanged,
    /// The staged slot changed: filled, recalibrated, discarded, or emptied by a
    /// promote. Reaches a recipient or not depending on who they are, not on
    /// what they just did.
    StagedChanged,

    /// Somebody is sweeping out a shape. Carries its payload, unlike the events
    /// above that are rebuilt per recipient, because a sketch is the same line
    /// for everyone allowed to see it and there's nothing in it to redact.
    ///
    /// No disk write and no state: it's gone when the mouse comes up.
    Sketching {
        by: ClientId,
        kind: ShapeKind,
        at: Pos,
        to: Pos,
        color: String,
    },
    /// A sweep ended: released, or its client disconnected. `by` is enough to
    /// find it, because there is only ever one per connection.
    SketchEnded { by: ClientId },
    /// Somebody pinged a spot on the board.
    ///
    /// Holds less state than a sketch. A `Sketching` is replaced by the next one
    /// and closed by a `SketchEnded`, and a socket dying has to close it too. A
    /// ping is one frame that lands, is relayed, and is over; nothing in the
    /// room records it.
    ///
    /// It carries both `by` and `owner` because they answer different questions
    /// and only `owner` reaches the wire. `by` is the connection, which the
    /// filter compares against so the pinger isn't echoed their own ring.
    /// `owner` is the identity, which the recipients draw. Resolved here, not in
    /// `message_for`, because the filter runs per recipient and this is one
    /// lookup for all six.
    Pinged { by: ClientId, owner: Owner, at: Pos },
    /// Somebody's pointer moved.
    ///
    /// `by` and `owner` mean the same as on `Pinged`, with one difference:
    /// **`message_for` filters this one.** A ping is relayed wherever it lands;
    /// the DM's pointer over unexplored ground isn't, because a pointer that
    /// lingers there shows the DM is working on something. `at` is read by that
    /// filter as well as drawn by the recipient, which is why it's carried here
    /// and not resolved per recipient.
    ///
    /// Holds even less state than `Pinged`: a ring stays on the recipient's
    /// screen on its own timer, while a cursor is replaced by the next frame and
    /// removed when it stops moving. Nothing in the room records where a pointer
    /// was.
    CursorMoved { by: ClientId, owner: Owner, at: Pos },
    /// The drawn shapes changed. Payload-free like `InitiativeChanged`, for two
    /// reasons: the list is short, and the table's copy differs from the DM's.
    ///
    /// One event for adding, deleting and clearing, and for three changes that
    /// come from elsewhere: a token being deleted, a token being hidden or
    /// revealed, and a new map arriving on the board.
    ShapesChanged,
    /// The traced walls changed: a run added, a segment erased, a door swung, or
    /// the board swept by a new map.
    ///
    /// Payload-free like the two above, for a simpler reason: it only ever has
    /// one recipient. Filtered by who the recipient is, like `StagedChanged` and
    /// `TokenPlanChanged`. A player is never told a wall exists, was erased, or
    /// was ever traced.
    ///
    /// **It must carry which board it's about**: the message rebuilt from it is
    /// a whole list, and the DM holds two. Reading the slot off `&self` at
    /// filter time would answer with whichever board the room holds by then, and
    /// a promote in between makes that the wrong one.
    WallsChanged { staged: bool },
    /// What the party can see changed: somebody moved, a door swung, a wall was
    /// traced, or the DM changed how far a torch reaches.
    ///
    /// Payload-free like the three above, and rebuilt into the same answer for
    /// every recipient, because fog is party-shared. Everyone is sent it, the DM
    /// included, unlike `WallsChanged`: the geometry is the secret, and the
    /// shadow it casts is what the table plays with.
    ///
    /// Never emitted from a drag frame. `moves_sight` decides that, so a party
    /// walking a corridor doesn't send a bitset thirty times a second.
    FogChanged,
    /// The DM painted, filled, or cleared some cells of their manual override.
    ///
    /// Travels like `WallsChanged`, for the same reason: this is what the DM
    /// decided, and `FogChanged` is what the table sees as a result. A player
    /// isn't sent it, not even empty. A frame they can't use still says the DM
    /// just did something, and when.
    ///
    /// On the live board it always comes with more: painting a cell there also
    /// moves the fog, so `refresh_fog` adds a `FogChanged` whenever anything the
    /// table can see changed. On the staged board this is the only event, since
    /// there is no fog on a map the table hasn't been shown.
    ///
    /// Carries its slot for the same reason as `WallsChanged`.
    OverridesChanged { staged: bool },

    /// Somebody said something, and the room has already logged it.
    ///
    /// Carries the whole line, like `Sketching` and `Pinged` and unlike the
    /// payload-free events above: the text is the same for everyone allowed to
    /// have it, so there is nothing to rebuild per recipient. `message_for` only
    /// decides *whether* each recipient gets it. A whisper is withheld from one
    /// player and sent to another, not withheld from every player as walls are.
    ///
    /// Unlike sketches and pings, the room does keep this: in memory, capped,
    /// and off `Saved`, which keeps it off the disk and out of the undo ring
    /// without either of those having to name it.
    Said { line: ChatLine },

    /// Somebody's scratchpad changed, and it is theirs.
    ///
    /// Goes only to the scratchpad's owner, and that applies to the DM too:
    /// their own is the only one they are ever told about. `message_for` asks
    /// whose it is and nothing else (no `is_dm`, no board, no fog).
    ///
    /// Carries `by` as well as `owner` for the same reason as `Pinged`: the
    /// socket that typed it already holds the text, and writing it back a round
    /// trip later would move the caret under whoever is still typing. That
    /// leaves the author's *other* tabs as the recipients, which is why this is
    /// an event at all.
    NotesChanged {
        by: ClientId,
        owner: Owner,
        text: String,
    },

    /// The DM undid something, and the room is now in a state it held earlier.
    ///
    /// The only event that describes the whole room, and the one place this
    /// project gives up on deltas. The case that makes undo worth having is
    /// `sweep_board`, where one map load clears the walls, the shapes and the
    /// fog together. Writing the inverse of that would be most of a second state
    /// model; re-sending everything uses a function that already exists.
    ///
    /// Payload-free, and rebuilt per recipient through `snapshot_for`, **so a
    /// restore is filtered by the same code as a join** (invariant 3). This is
    /// the second message that sends the whole world, and the whole world is
    /// where a leak usually happens.
    Restored,
    /// What the DM's undo would take back has changed.
    ///
    /// Reaches the DM or nobody, like `WallsChanged` and `OverridesChanged`, but
    /// not because it's secret: a player has no undo button for it to label.
    ///
    /// Payload-free because `message_for` reads the ring off `&self`. It goes
    /// out with every step added and every step taken back, the same pairing as
    /// `OverridesChanged` and `FogChanged`: the room changed, and so did what
    /// the DM's next undo would do.
    UndoChanged,

    /// Somebody joined or left.
    ///
    /// The only event no command produced. Every other variant follows a
    /// `ClientMsg` that arrived and was allowed; this one is dispatched from the
    /// two places the socket table changes: a `Hello` that became an identity,
    /// and a connection that went away. It's also why `persists` refuses it on
    /// principle rather than for being ephemeral: who is connected isn't part of
    /// the room.
    ///
    /// Payload-free; `message_for` reads the list off `&self`, and every
    /// recipient gets the same one.
    PresenceChanged,
    /// A player picked their colour.
    ///
    /// Payload-free and the same for every recipient, the sender included.
    /// There's no reason to skip the sender: nothing was drawn locally and there
    /// is no caret for an echo to move. That's the difference from
    /// `NotesChanged`, the other thing here that a player writes.
    ColoursChanged,
}

impl Initiative {
    fn index_of(&self, token: &TokenId) -> Option<usize> {
        self.entries.iter().position(|e| &e.token == token)
    }

    /// Adds or re-values a token, then restores the sort. `sort_by` is stable,
    /// so equal values keep the order the DM entered them in.
    ///
    /// Doesn't touch `current`. The DM types values in whatever order the
    /// table calls them out, so "first entered" says nothing about who acts
    /// first. Combat begins when the DM advances the turn.
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
            // Whoever slid into that slot takes the turn, the natural reading
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

/// Who a connection turned out to be. An enum, not an `is_dm` + `player_id`
/// pair, so "a DM with a roster slot" and "a player who is also DM" can't be
/// represented at all.
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
/// together instead of being fetched where they are used: after the recompute,
/// neither can be read off `&self` any more. It's the same reason the token
/// events carry `was_unseen`: to tell a monster that just walked out of the
/// light from one the party was never told about.
struct Sight {
    /// The frame the clients are currently holding, or `None` on an unfogged map.
    fog: Option<FogView>,
    /// Every token the table could see. Ids, not a count: which ones matters,
    /// and two tokens can trade places in the same step.
    seen: HashSet<TokenId>,
    /// Every shape the table could see, as ids for the same reason.
    ///
    /// It can't be folded into `seen`, because it tracks different things. It
    /// can't be left out either, because an unanchored shape gates on the fog:
    /// the fog opening onto ground somebody drew a circle on changes what the
    /// table sees with no token involved, so the token set alone can't decide
    /// whether to send `ShapesChanged`.
    shapes: HashSet<ShapeId>,
}

/// The staged slot as the room holds it: the map the DM is preparing, and the
/// walls and overrides they have prepared on it.
///
/// The counterpart of `StagedView`, the same split as `Token`/`TokenView`:
/// that type crosses the wire and goes to disk, and this is what the room
/// computes with. The difference is one field: the overrides are a packed
/// rectangle there and a map of cells here, as the live board's are.
///
/// A bundle, not three fields beside `staged`, because the three arrive, sweep
/// and promote as one thing. The live board's stay flat on `RoomState` below.
/// That asymmetry isn't an unfinished refactor: the live board is the room, and
/// this is waiting to be moved into it.
#[derive(Debug, Clone, Default)]
struct StagedBoard {
    map: MapInfo,
    /// Traced over the staged image before the table has seen it. They add
    /// nothing to filter: a wall reaches the DM or nobody. (`staged_only`, by
    /// contrast, needed a third reason in `unseen_by_table`.)
    walls: Vec<Wall>,
    /// Painted over the staged board by hand, and promoted with it.
    ///
    /// There is no staged `revealed`, `known` or `visible` under these. A staged
    /// override isn't a preview of what the party will see; it's what the DM
    /// hands them the moment the map lands. See *No staged fog* in
    /// `docs/fog.md`.
    overrides: HashMap<Cell, Override>,
}

impl StagedBoard {
    /// The wire and disk form of this slot. One function, because what the DM
    /// may hold of the staged board and what the file must hold of it are the
    /// same. A player holds none of it either way, so there's nothing for a
    /// `view_for` to redact.
    fn view(&self) -> StagedView {
        StagedView {
            map: self.map.clone(),
            walls: self.walls.clone(),
            overrides: fog::pack_overrides(&self.overrides),
        }
    }
}

pub struct RoomState {
    dm_secret: String,
    roster: Vec<RosterEntry>,
    map: MapInfo,
    /// The map the DM is preparing for later, which the table can't see, and
    /// everything they have prepared on it. Stripped in `snapshot_for` and
    /// filtered out in `message_for`. Because the three are one bundle, that's
    /// one `None` rather than three fields that could each be forgotten.
    staged: Option<StagedBoard>,
    tokens: HashMap<TokenId, Token>,
    initiative: Initiative,
    /// Everything drawn on the board, in draw order.
    ///
    /// A `Vec`, not a `HashMap` keyed by id like the tokens: the list is short,
    /// it's only looked up by id when something is deleted, and its order is
    /// the z-order, which a map would have to be sorted back into on every send.
    /// Shapes belong to the live board only; the staged map has none.
    shapes: Vec<Shape>,
    /// The walls and doors traced over the map image, in image pixels.
    ///
    /// A `Vec` for the same reason as the shapes, except that the order here
    /// means nothing; it's the order they were traced in. **These are the live
    /// board's walls.** The staged board has its own list on `StagedBoard`, and
    /// a promote moves one into the other. That's still one slot, not the scene
    /// system CLAUDE.md rules out.
    walls: Vec<Wall>,
    /// Everywhere the party's own torches have ever reached, in grid cells.
    ///
    /// **Only rays write here, never an override.** That's what makes an
    /// override removable: if `Explored` and `Lit` were unioned in, the cells
    /// would stay after the paint was cleared and a fill would be permanent.
    /// What the table is shown is `known` below, which is this with the mask
    /// applied.
    ///
    /// Persisted, and the only part of the fog that is: it's what the party
    /// remembers about the dungeon, and an evening of exploring belongs to the
    /// map it was done on. Cleared by `sweep_board` and by `ResetFog`. It's in
    /// grid space, so a new map is a new lattice and a recalibration invalidates
    /// it; the walls, in image pixels, survive both.
    ///
    /// Only grows within one map, apart from those two. `fog.rs` clips what may
    /// go in it to the board, which stops a token dragged into the void from
    /// adding a cell a million squares away.
    revealed: HashSet<Cell>,
    /// What the table is shown as terrain: `revealed`, as the DM's mask leaves it.
    ///
    /// Derived and never persisted, like `visible` below. The two are one
    /// raycast plus one pass of the overrides, and `recompute_sight` builds both
    /// together. `fog_for` packs this and an unanchored shape gates on it.
    /// Neither reads `revealed`: reading it instead would put a room the DM
    /// blacked out back on the table's board.
    known: HashSet<Cell>,
    /// Where the party can see *now*. Derived, never persisted, and recomputed by
    /// `refresh_fog`, not in the visibility filter. The filter runs against
    /// `&self` while the client map is borrowed, so it can't mutate this, and
    /// it's better kept pure anyway.
    visible: HashSet<Cell>,
    /// Which tokens the table has been shown, as of the last recompute.
    ///
    /// Derived and never persisted, like the two sets above. **It must be
    /// recorded when the recompute runs, not read back off the room when the
    /// next command arrives.** A drag frame moves a token in memory without a
    /// recompute, so by the time the drop asks what the table could see a moment
    /// ago, the creature has already been carried into the dark and `&self`
    /// says "they never saw it". The monster then stays on the table's board at
    /// the last cell a frame reached them. See `docs/fog.md`.
    shown: HashSet<TokenId>,
    /// What the DM has set on particular cells, overriding the rays.
    ///
    /// A mask applied after the raycast, not a write into `revealed`, which is
    /// why it's separate state: a hide that cleared `revealed` would be undone
    /// the next time somebody carried a torch past, and a reveal that wrote into
    /// it could never be taken back.
    ///
    /// The DM's authoring data, and it travels like the walls, not like the fog:
    /// sent whole to the DM, never to a player, and clipped to the board before
    /// anything is stored. Persisted, unlike `visible`, because nothing in the
    /// room can derive what somebody decided.
    ///
    /// Cleared by `sweep_board` with `revealed`, for the same reason: these are
    /// cells, so a new lattice invalidates them. These are the live board's; the
    /// staged board paints into its own map on `StagedBoard`, and a promote
    /// replaces these with those.
    overrides: HashMap<Cell, Override>,
    /// Whether the board writes each token's name under it.
    ///
    /// Room-wide, not per map or per token. Per map would fork it between the
    /// two slots and reset it every time a dungeon was loaded; per token would
    /// be six checkboxes to answer one question. The DM sets it and everyone
    /// holds it. See `RoomView::show_names` for why it isn't filtered.
    show_names: bool,
    /// How the movement ruler counts a diagonal.
    ///
    /// Like `show_names`: room-wide, set by the DM, held by everyone, filtered
    /// by nobody. **Nothing on this server reads it** (there's no movement
    /// distance in this crate), and that isn't dead state: the room is what
    /// makes six clients agree, which they wouldn't if this lived in a browser.
    diagonals: Diagonals,
    /// Whether everybody's pointer is drawn on everybody's board.
    ///
    /// Like the two above: set by the DM, held by everyone, filtered by nobody.
    /// The difference is that this one is read *in the filter*: `CursorMoved`
    /// is dropped for every recipient while it's off, so the frames stop
    /// crossing the wire, not just stop being drawn. Cursor moves are the
    /// busiest message in the room, and a switch that saved no traffic would
    /// be a client preference.
    show_cursors: bool,
    /// Whether the DM's own pointer is drawn on the players' boards.
    ///
    /// `show_cursors` for the DM's pointer only, and read in the same place.
    /// `cursor_seen` already withholds the DM's pointer from a player over
    /// ground the party hasn't explored; this widens that from the dark to
    /// everywhere. It doesn't change what a client *sends*, because one client
    /// in seven isn't traffic worth a branch at the send site.
    show_dm_cursor: bool,
    /// The picture the table is looking at instead of the board, or `None`.
    ///
    /// Like the switches above, except that it carries a URL, not a flag.
    /// **Nothing else in this struct reads it.** The board, its walls, its
    /// shapes and everywhere the party has explored stay untouched behind the
    /// picture, so taking it down puts the table back where they were. A
    /// backdrop is not a map: see `docs/maps.md`.
    backdrop: Option<String>,
    /// The music the room is playing, or `None`. Room-wide, set by the DM.
    ///
    /// **Memory only, like `chat` and unlike every other field around it.** It's
    /// off `Saved`, so it's off the undo ring without an exemption like the ones
    /// `notes` and `colours` need. Re-assigning an `<audio>` source restarts the
    /// track, so a restore that set the music back to a previous pick would
    /// restart it mid-scene; and a room reopened on Saturday should come back
    /// silent, not resume Tuesday's prep. See `docs/sound.md`.
    audio: Option<String>,
    /// Everything the DM has prepared on each map, keyed by its URL: the grid
    /// they calibrated, the walls they traced and the fog they painted.
    ///
    /// Server-side only. It never enters a snapshot or a message, because the
    /// finished `MapInfo` and the board's own `walls` already say everything a
    /// client needs. It's a shelf, not a scene list: it holds what the DM
    /// authored on an image and nothing about play (no tokens, no initiative,
    /// and no `revealed`). See `docs/maps.md`.
    calibrations: HashMap<String, Prepared>,
    /// The last few states of the room, oldest first, for the DM's undo.
    ///
    /// **Each entry is the state after a change, so the back is always the room
    /// as it is now.** An undo pops that and adopts whatever is behind it, which
    /// is why the ring is never empty: it's seeded on boot with the room as
    /// loaded, and that entry is the floor, not a step.
    ///
    /// A snapshot is a `Saved`, not a hand-picked subset, which keeps this
    /// cheap to maintain. `Saved` already defines the room without the
    /// parts that die with the process, so `clients` and `pending` can't be in
    /// a snapshot. Restoring a live socket table from ten commands ago would
    /// break the room, and it can't happen because state is defined once.
    ///
    /// In memory only, and not on `Saved` itself: a ring inside a ring is a
    /// file that doubles every save, and nobody wants an evening's undo history
    /// after a restart.
    ///
    /// Only state the DM could have written goes in it. The shapes a player drew
    /// qualify, because the DM can already erase any of them. The scratchpads
    /// and colours don't: restoring someone's notes from ten commands ago would
    /// lose their paragraph with nothing on screen to say so. See the `Undo` arm
    /// of `apply` and `docs/undo.md`.
    undo: VecDeque<Snapshot>,
    /// What has been said this session, oldest first.
    ///
    /// **Memory only, not on `Saved`.** Two things follow without a rule of
    /// their own: old whispers are never written to a disk somebody could read,
    /// and an undo can't take back what the table said. A snapshot is a
    /// `Saved`, so this isn't in one, and `adopt` leaves it where it is.
    ///
    /// A `VecDeque` because the cap trims from the front: the oldest line goes
    /// when the newest arrives.
    ///
    /// Not filtered here. The room holds every line; who may see which is
    /// `party_to`, asked per recipient in `snapshot_for` and in `message_for`.
    chat: VecDeque<ChatLine>,
    /// One box of text per person, private to whoever wrote it. The DM's is no
    /// different from anyone else's.
    ///
    /// **The only state the DM is not sent.** Every other filter withholds from
    /// players; neither `snapshot_for` nor `message_for` checks `is_dm` here,
    /// because a scratchpad somebody else's client can open is surveillance,
    /// and nobody writes freely in a box they know is read.
    ///
    /// Persisted, unlike `chat`. That makes it worth having over the Notepad
    /// window everyone already has open: it's in the same window and it
    /// survives the Pi rebooting. Being persisted is also why it needs excluding
    /// from undo by hand. See the `Undo` arm of `apply`, the one place a restore
    /// is told to leave something alone.
    ///
    /// Keyed by `Owner` and never by anything a client says: `SetNotes` carries
    /// no key, because a key a client could name is a key it could use to name
    /// somebody else's.
    notes: HashMap<Owner, String>,
    /// Which colour each player picked for themselves.
    ///
    /// Unlike the scratchpads, this is public. A colour is only worth picking
    /// because the other six screens draw your ring and your lines in it, so
    /// `snapshot_for` sends the whole table to everyone and there's no filter.
    /// Only its owner can write it: `SetColour` names no slot, as `SetNotes`
    /// names no box.
    ///
    /// Persisted, so it's on `Saved` and would be on the undo ring, and needs
    /// the same hand-written exemption as `notes`. See the `Undo` arm of
    /// `apply`. **The ring holds only state the DM could have written**, and a
    /// player's colour isn't the DM's to take back.
    ///
    /// Keyed by `PlayerId`, not `Owner`, so the type says the DM has no entry
    /// here, with no check needed. The DM's hue is outside the six.
    colours: Colours,
    /// Identified clients. Only these receive events.
    clients: HashMap<ClientId, Client>,
    /// Connected but not yet identified. They hold a sender and nothing else.
    pending: HashMap<ClientId, mpsc::Sender<ServerMsg>>,
}

/// One entry in the undo ring: a whole room, and what the command that produced
/// it did.
///
/// The label describes how this state was *arrived at*, so undoing to the entry
/// behind it undoes the thing this one is named after. That's why the button
/// reads the label off the back of the ring, not the entry before it. With no
/// redo, the DM has to be told what a press takes back before they press.
struct Snapshot {
    /// Never read on the seed entry, which nothing arrived at. It's a real
    /// sentence anyway, not an empty string, so a bug that shows it produces
    /// readable text instead of a blank button.
    did: String,
    state: Saved,
}

/// Starts one room's actor and hands back the handle sockets reach it through.
///
/// `roster` is the room's cast and `demo` says whether a missing save file means
/// the built-in board or an empty one. Both come from `ROOMS`, and the caller
/// looks them up so that this function knows about one room, not the table of
/// them.
pub fn spawn(
    dm_secret: String,
    roster: Vec<RosterEntry>,
    saved: Option<Saved>,
    store: Store,
    demo: bool,
) -> RoomHandle {
    let mut state = match (saved, demo) {
        (Some(saved), _) => RoomState::restored(saved, dm_secret, roster),
        (None, true) => RoomState::hardcoded(dm_secret),
        (None, false) => RoomState::blank(dm_secret, roster),
    };
    // `known` and `visible` are derived and neither is on disk, so a room that
    // has just booted holds neither, and the first client to join would be told
    // the party can see nothing and remembers nothing: the whole dungeon dark on
    // a map they had explored. Done here, not in the constructors, so there is
    // one place to forget it instead of three.
    state.recompute_sight();

    let (tx, rx) = mpsc::channel(ROOM_MAILBOX);
    tokio::spawn(run(state, rx, store));
    RoomHandle { tx }
}

async fn run(mut state: RoomState, mut rx: mpsc::Receiver<RoomCmd>, store: Store) {
    // `Some(deadline)` is the dirty flag; there's no other. It's an absolute
    // instant, not a duration, because the timer is rebuilt on every command:
    // restarting a countdown thirty times a second would let a long drag hold
    // the save off indefinitely, whereas a fixed deadline caps how stale the
    // file can get no matter how much traffic arrives.
    let mut save_at: Option<Instant> = None;
    let mut health = SaveHealth::default();

    loop {
        // `Receiver::recv` is cancel-safe, so losing the race to the timer
        // discards nothing: the command is still queued next time round.
        let cmd = match save_at {
            None => rx.recv().await,
            Some(at) => tokio::select! {
                cmd = rx.recv() => cmd,
                _ = sleep_until(at) => {
                    save_at = flush(&state, &store, &mut health).await;
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
                state.remove_client(client);
                // Who is connected isn't part of the room, so this isn't a
                // change to save, and `persists` refuses `PresenceChanged` for
                // the same reason.
                false
            }
            RoomCmd::Msg { client, msg } => state.handle(client, msg),
            RoomCmd::Shutdown { done } => {
                let saved = if save_at.is_some() {
                    // A shutdown is allowed to wait for the disk. A failed save
                    // is still logged by `flush`; there is no useful retry once
                    // the process has been asked to stop.
                    flush(&state, &store, &mut health).await.is_none()
                } else {
                    true
                };
                let _ = done.send(saved);
                return;
            }
            RoomCmd::Status { done } => {
                // `save_at` is the dirty flag and it lives here, so the struct
                // is finished here, not on `RoomState` alone.
                let _ = done.send(state.status(save_at.is_some(), &health));
                // Asking a room a question doesn't change it.
                false
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
        flush(&state, &store, &mut health).await;
    }
}

/// Writes the room out and returns the next deadline: `None` once it is safely
/// on disk, or a retry if it is not. Clearing the flag on a failed write would
/// throw the change away silently, and a disk is rarely full for long.
async fn flush(state: &RoomState, store: &Store, health: &mut SaveHealth) -> Option<Instant> {
    match store.save(&state.to_saved()).await {
        Ok(()) => {
            debug!(path = %store.path().display(), "room saved");
            health.failing = false;
            // Wall clock, not the `Instant` above, because this one is shown to
            // a person and an `Instant` can't be formatted. A clock that has
            // never been set reads as the epoch instead of failing.
            health.last_ok_unix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|since| since.as_secs())
                .ok();
            None
        }
        Err(err) => {
            error!(%err, path = %store.path().display(), "could not save the room; will retry");
            // Set until a write succeeds, not just for this attempt. The retry
            // loop is otherwise silent, so without this the status page would
            // only catch the failure if it asked during the wrong two-second
            // window.
            health.failing = true;
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
        // into place like a position, and its drag frames are no more worth
        // saving than a live drag's.
        Event::TokenMoved { dragging, .. } => !dragging,
        Event::TokenChanged { .. }
        | Event::TokenRemoved { .. }
        | Event::TokenPlanChanged { .. }
        | Event::Promoted { .. }
        // Four switches the DM flipped once and expects to find flipped next
        // week.
        | Event::NamesChanged
        | Event::DiagonalsChanged
        | Event::CursorsChanged
        | Event::DmCursorChanged
        // And the picture the DM left up, for the same reason: a room reopened
        // on Saturday should be looking at whatever it was looking at.
        | Event::BackdropChanged
        | Event::InitiativeChanged
        | Event::MapChanged
        | Event::StagedChanged
        | Event::ShapesChanged
        // Half an hour of tracing. Losing the last two seconds here would lose
        // the segment the DM was most likely in the middle of.
        | Event::WallsChanged { .. }
        // Only `revealed` is on disk, and only it can have grown here. Saving
        // with the drop that caused it costs nothing (that frame already marked
        // the room dirty), and a session's exploration should survive a
        // restart.
        | Event::FogChanged
        // Same as the walls: this is somebody's work, and nothing in the room
        // could reconstruct it if the file lost it.
        | Event::OverridesChanged { .. }
        // An undo moves the room to a state it held before, which changes what
        // should be on disk as much as the command it took back did. Leaving it
        // out would let the file keep the undone version until something else
        // was saved.
        | Event::Restored => true,
        // A sketch isn't in the room to be saved. It exists only between two
        // pointer events, so a measuring line costs the disk nothing.
        //
        // A ping exists only for the one pointer event that sent it, so the
        // room never holds it at all.
        //
        // `UndoChanged`: the ring lives in memory and isn't on `Saved`, so
        // there's nothing for a write to capture. It goes out beside events
        // that do persist, so this arm never suppresses a save that was wanted.
        //
        // A chat line is the one thing here the room *does* keep and still
        // doesn't write down. It's session memory: whispers from a Tuesday
        // shouldn't be stored on a disk in somebody's front room, and an
        // evening's initiative rolls are worth nothing the morning after. The
        // same decision keeps it out of the undo ring, since a snapshot is
        // whatever `Saved` describes.
        //
        // Presence is refused on principle, not for being short-lived: who is
        // connected isn't part of the room, and a file that recorded it would
        // boot claiming five people were in a house nobody is in.
        //
        // A cursor is shorter-lived than a ping: it's current for a sixteenth
        // of a second and isn't a choice anybody made. The room never holds
        // one.
        Event::Sketching { .. }
        | Event::SketchEnded { .. }
        | Event::Pinged { .. }
        | Event::CursorMoved { .. }
        | Event::Said { .. }
        | Event::PresenceChanged
        // Music is like `Said`, not like the short-lived events: the room holds
        // it and still doesn't write it down. A track is something the room is
        // doing, not part of what it is, and a room reopened on Saturday should
        // come back silent instead of resuming whatever the DM was prepping to
        // on Tuesday. The same decision keeps it off the undo ring, since a
        // snapshot is whatever `Saved` describes, so it needs no exemption,
        // unlike the two arms below.
        | Event::AudioChanged
        | Event::UndoChanged => false,

        // The room keeps these and also writes them down. Surviving a restart
        // is most of what a scratchpad is worth, and a colour that had to be
        // picked again every session wouldn't be worth picking. They're the two
        // things a player writes that reach the disk, which is also why the
        // undo ring has to be told to leave them alone.
        Event::NotesChanged { .. } | Event::ColoursChanged => true,
    }
}

/// What this command should be called on the undo button, or `None` for one
/// that is never a step to go back to.
///
/// Enumerated like `persists` and `moves_sight`, with no catch-all, for the
/// same reason: a command added later and forgotten here stops being undoable,
/// which looks like the ring being shallow, not like a missing arm.
///
/// The two lists are asked together (a step exists when a command has a label
/// *and* produced something worth writing to disk), so this one doesn't have
/// to re-derive which commands change the room. What it adds is the exclusions
/// `persists` can't express:
///
/// - `Undo` itself. Undoing pushes nothing. Otherwise the ring would grow a
///   new top every time the DM walked back down it, and the second press would
///   return to where the first one started.
/// - Commands that don't author a change: `Hello`, the ephemeral ones, and
///   chat. They persist nothing either, so this is a second guard, not the
///   only one.
/// - State a player owns: the scratchpad and the colour. `persists` says
///   yes to these, so this is the only guard, and the `Undo` arm of `apply`
///   is the other half of it.
///
/// The labels complete "undo …" and are written the way the DM would say what
/// they did, not the way the protocol spells it. They are `&'static str`, not
/// built from the room: a name looked up here would be the name *after* the
/// change, so undoing a rename would offer to undo the new name.
fn undid(msg: &ClientMsg) -> Option<&'static str> {
    match msg {
        // A drag frame isn't a step of its own (`persists` already says so),
        // and the drop that follows carries the position that was chosen.
        ClientMsg::MoveToken { staged, .. } => Some(if *staged {
            "planning a move"
        } else {
            "moving a token"
        }),
        ClientMsg::CreateToken { .. } => Some("building a token"),
        ClientMsg::UpdateToken { .. } => Some("editing a token"),
        ClientMsg::DeleteToken { .. } => Some("deleting a token"),
        ClientMsg::SetShowNames { .. } => Some("the name switch"),
        ClientMsg::SetDiagonals { .. } => Some("the diagonal rule"),
        ClientMsg::SetShowCursors { .. } => Some("the cursor switch"),
        // Named for whose pointer it is, not which way it went, like the
        // backdrop below: "the DM pointer switch" is true either way.
        ClientMsg::SetShowDmCursor { .. } => Some("the DM pointer switch"),
        // Named for what it is, not which way it went, like the map below:
        // "the backdrop" is true whether the DM put one up or took one down.
        ClientMsg::SetBackdrop { .. } => Some("the backdrop"),
        // Loading and recalibrating are one command, so this label has to cover
        // both without claiming which. "The map" is true either way.
        ClientMsg::SetMap { .. } => Some("the map"),
        ClientMsg::PromoteStaged => Some("promoting the next map"),
        ClientMsg::ClearStaged => Some("discarding the next map"),
        ClientMsg::AddShape { .. } => Some("a drawing"),
        ClientMsg::RemoveShape { .. } => Some("erasing a drawing"),
        ClientMsg::ClearShapes => Some("erasing every drawing"),
        ClientMsg::AddWalls { .. } => Some("tracing walls"),
        ClientMsg::RemoveWall { .. } => Some("erasing a wall"),
        ClientMsg::ToggleDoor { .. } => Some("a door"),
        ClientMsg::ClearWalls { .. } => Some("erasing every wall"),
        ClientMsg::SetFogOverride { .. } => Some("painting the fog"),
        ClientMsg::ResetFog => Some("resetting the fog"),
        ClientMsg::SetInitiative { .. } => Some("an initiative row"),
        ClientMsg::RemoveFromInitiative { .. } => Some("removing an initiative row"),
        ClientMsg::ClearInitiative => Some("clearing the order"),
        ClientMsg::NextTurn | ClientMsg::PreviousTurn => Some("the turn"),
        // The first exclusion above. Without it, undo would push itself.
        ClientMsg::Undo => None,
        ClientMsg::Hello { .. }
        | ClientMsg::Sketch { .. }
        | ClientMsg::Ping { .. }
        // Where a pointer is isn't a step in anything. It persists nothing, so
        // this arm is the second guard, not the rule.
        | ClientMsg::MoveCursor { .. }
        // Nothing anybody said is the DM's to take back. This persists nothing,
        // so `persists` would refuse it anyway.
        | ClientMsg::Say { .. }
        // A roll is a chat line and is excluded for the same reason, with more
        // at stake: undo would be a button that could un-throw a die somebody
        // is reading the number off.
        | ClientMsg::Roll { .. }
        // `persists` says yes to this one, so this arm is what keeps it off the
        // ring. The ring holds only state the DM could have written, and undoing
        // somebody's paragraph would lose work they can't get back, with
        // nothing on screen to explain it. This is half the exclusion; the other
        // half is the `Undo` arm of `apply`, which tells a restore to leave the
        // scratchpads alone.
        | ClientMsg::SetNotes { .. }
        // `persists` says yes to this one too. A colour belongs to a player the
        // way a scratchpad does, and the DM's undo changing what colour a player
        // draws in would be the same unexplained surprise. The other half is in
        // the `Undo` arm of `apply`, and it's needed for the same reason: a
        // colour picked *between* two commands is on the snapshot the later one
        // pushed.
        | ClientMsg::SetColour { .. }
        // `persists` already says no to this one. Music isn't on `Saved`, so a
        // snapshot never holds a track and a restore can't change one. The arm
        // is here because the match is exhaustive, and unlike the scratchpad and
        // colours it needs nothing in the `Undo` arm of `apply`.
        | ClientMsg::SetAudio { .. } => None,
    }
}

/// Which commands could have changed what the party can see.
///
/// Enumerated like `persists`, with no catch-all: a command added later and
/// forgotten here would leave the fog stale, which looks like a bug in the
/// raycast, not a missing arm. The two lists ask different questions and mostly
/// agree. The notable disagreement is shapes, which are worth a disk write and
/// can't block sight.
///
/// A drag frame isn't one. The fog is recomputed on the drop: the raycast is
/// cheap enough at 30 Hz, but sending a packed bitset to six people that often
/// isn't, so the fog opens as a token settles, not as it travels. What still
/// happens mid-drag is the *filter*: a monster dragged into a cell the party
/// can't currently see stops being relayed to them at once, because that
/// decision reads `visible` and doesn't rebuild it.
fn moves_sight(msg: &ClientMsg) -> bool {
    match msg {
        // A plan is a cell on a map the table hasn't been shown, and nothing on
        // the staged board casts a shadow on this one.
        ClientMsg::MoveToken {
            dragging, staged, ..
        } => !dragging && !staged,
        // Geometry and paint each name a board, as a token move does, and for
        // the same reason: nothing on the staged board casts a shadow on the
        // live one. There's no staged fog for a staged wall to block or a
        // staged override to mask, so tracing the next dungeon must not
        // recompute this one's sight. That would be a raycast per click of a
        // two-hundred segment trace, all to find nothing had changed.
        ClientMsg::AddWalls { staged, .. }
        | ClientMsg::RemoveWall { staged, .. }
        | ClientMsg::ToggleDoor { staged, .. }
        | ClientMsg::ClearWalls { staged }
        | ClientMsg::SetFogOverride { staged, .. } => !staged,
        // Any of these can add, remove or re-own a vision source (handing a
        // token to a player gives them one), move the lattice the cells are
        // counted on, or change what blocks a ray.
        //
        // `SetMap` is here whichever slot it names, unlike the five above:
        // filling the staged slot sweeps that board's tokens, and a promote
        // makes everything staged what the party is looking at.
        ClientMsg::CreateToken { .. }
        | ClientMsg::UpdateToken { .. }
        | ClientMsg::DeleteToken { .. }
        | ClientMsg::SetMap { .. }
        | ClientMsg::PromoteStaged
        | ClientMsg::ClearStaged
        // The one command here that changes what the party can see without
        // changing the room they're looking at. The mask is applied inside
        // `recompute_sight`, so it needs no arm of its own anywhere else. It
        // names no slot: there's no staged fog to reset.
        | ClientMsg::ResetFog => true,
        // Nothing drawn on the board blocks sight, a sketch isn't in the room
        // at all, the turn order is a panel, and a name label is drawn over
        // the light, not part of it.
        ClientMsg::Hello { .. }
        | ClientMsg::SetShowNames { .. }
        // A pointer is drawn over the light like the ruler is, and switching
        // every pointer off changes what's on a screen, not what a ray reaches.
        | ClientMsg::SetShowCursors { .. }
        // Same for the DM's pointer alone: whose pointers are drawn changes no
        // ray.
        | ClientMsg::SetShowDmCursor { .. }
        // A picture in front of the board: the board is still there, lit as it
        // was, with something in front of it.
        | ClientMsg::SetBackdrop { .. }
        // Music has nothing on the board to be seen.
        | ClientMsg::SetAudio { .. }
        | ClientMsg::MoveCursor { .. }
        // A ruler is drawn over the light, and this only changes what the ruler
        // says.
        | ClientMsg::SetDiagonals { .. }
        | ClientMsg::Sketch { .. }
        | ClientMsg::AddShape { .. }
        | ClientMsg::RemoveShape { .. }
        | ClientMsg::ClearShapes
        // Pointing at a room doesn't light it. Don't flip this arm: a ping on
        // unexplored ground stays a ring over black.
        | ClientMsg::Ping { .. }
        // Chat isn't on the board. The fog doesn't apply to it.
        | ClientMsg::Say { .. }
        // Nor does a roll, which arrives in the log as a chat line.
        | ClientMsg::Roll { .. }
        // A scratchpad is on one person's screen and not on the board.
        | ClientMsg::SetNotes { .. }
        // What colour a ring is drawn in doesn't change what a ray reaches.
        | ClientMsg::SetColour { .. }
        | ClientMsg::SetInitiative { .. }
        | ClientMsg::RemoveFromInitiative { .. }
        | ClientMsg::ClearInitiative
        | ClientMsg::NextTurn
        | ClientMsg::PreviousTurn
        // **False because it recomputes sight itself.** An undo moves the
        // walls, the tokens and the party's memory at once, so sight certainly
        // changes. But the frame it produces carries a whole `RoomView` with
        // the fog already in it, and `refresh_fog` on top would send everyone
        // a second, redundant copy of the same board. `apply` recomputes there
        // instead. See `ClientMsg::Undo`.
        | ClientMsg::Undo => false,
    }
}

/// `what` completes "only the DM can …", so the refusal names the thing that
/// was refused and the player doesn't have to guess which rule they hit.
fn require_dm(client: &Client, what: &str) -> Result<(), String> {
    match client.identity {
        Identity::Dm => Ok(()),
        Identity::Player(_) => Err(format!("only the DM can {what}")),
    }
}

/// Rejects the infinities before they can reach `RoomState`.
///
/// This is about the save file, not arithmetic. `serde_json` writes a
/// non-finite `f32` as `null`, and `null` doesn't deserialize back into an
/// `f32` (`#[serde(default)]` fills in *missing* fields, not null ones). One
/// such value reaching the room would be written to disk and then fail to
/// load, and the server wouldn't boot until somebody edited the file by hand.
///
/// The route in is narrow and easy to dismiss: `serde_json` rejects a literal
/// `NaN` as invalid JSON and `1e400` as out of range. But `1e39` is a valid
/// `f64`, and narrowing it to `f32` gives infinity. That one gets all the way
/// here.
fn finite(values: &[f32]) -> Result<(), String> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err("that is not a position".to_owned())
    }
}

/// `#rrggbbaa`, and nothing else. Accepting one format instead of any CSS
/// colour keeps validation simple: the client always writes this form, and the
/// server never has to reason about what `hsl(...)` means or hand the browser a
/// string that turns out not to be a colour.
fn is_hex_rgba(s: &str) -> bool {
    s.len() == 9 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Everything a token carries besides its position and its id, checked once for
/// both the command that creates a token and the command that edits one.
///
/// `img` is held to a site-relative path. The DM is trusted, so this isn't a
/// permission check; it keeps the room self-contained. A token pointing at
/// somebody else's server loses its art the evening that server is down, and
/// it would be the one thing in a save the uploads directory doesn't back.
///
/// `hidden` needs no check: a bool has no bad value, and the DM may set either.
fn token_fields(
    name: &str,
    img: &str,
    size: f32,
    hp: Option<Hp>,
    light_ft: Option<f32>,
    markers: &[Marker],
) -> Result<(), String> {
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
    // Each is bounded, but not checked against the other: whether `current` may
    // exceed `max` depends on what a hit point means, and that's rules
    // knowledge. The DM writes down two numbers and the room keeps them.
    if let Some(hp) = hp
        && (!(-MAX_HP..=MAX_HP).contains(&hp.current) || !(-MAX_HP..=MAX_HP).contains(&hp.max))
    {
        return Err(format!(
            "hit points must be between {} and {MAX_HP}",
            -MAX_HP
        ));
    }
    // The same bounds `SetMap` holds the map's radius to: the sweep is
    // quadratic in the reach, and a light is a source in the same sweep. `None`
    // is the usual state. Most tokens carry no light of their own, and a
    // player's takes the map's number.
    if let Some(ft) = light_ft
        && !(fog::MIN_VISION_FT..=fog::MAX_VISION_FT).contains(&ft)
    {
        return Err(format!(
            "a light has to reach between {} and {} feet",
            fog::MIN_VISION_FT,
            fog::MAX_VISION_FT
        ));
    }
    // **The list is a set, and refusing duplicates is what bounds its length.**
    // `Marker::ALL` is a closed set, so a list with no repeats can't be longer
    // than that however long the array on the wire was. That's the count bound
    // `docs/net.md` asks of every command carrying a variable-length
    // collection. The byte bound is
    // `tokens::the_largest_token_edit_fits_in_a_frame`.
    //
    // The length is tested first because the scan below is quadratic. The
    // frame cap already keeps that to a few million comparisons at worst, so
    // this isn't needed for safety; it's one comparison before a loop, and
    // doing the cheap test first costs nothing.
    if markers.len() > Marker::ALL.len() {
        return Err(format!(
            "a token can carry at most {} markers",
            Marker::ALL.len()
        ));
    }
    if markers
        .iter()
        .enumerate()
        .any(|(i, m)| markers[..i].contains(m))
    {
        return Err("a token cannot carry the same marker twice".to_owned());
    }
    Ok(())
}

/// The geometry a sketch and a kept shape have in common, checked once for both.
///
/// The extent bound is the one that matters. It stops a single frame from
/// walking a million cells on five other people's machines, and it has to be
/// checked on the sketch as well as on the shape, because the sketch reaches
/// them first.
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

/// Throw `count` dice of `sides` faces, uniformly, and give back what each one
/// landed on.
///
/// The randomness comes from `uuid`, which is already a dependency. A v4 is
/// sixteen bytes from the OS, the same source `main` mints the DM secret from,
/// so there's no need to add `rand`.
///
/// Rejection sampling, not `byte % sides`, which biases low faces: 256 isn't a
/// multiple of 100, so on a d100 the bytes below 56 would land twice as often
/// as the rest. `limit` is the largest multiple of `sides` that fits in a byte,
/// and anything at or above it is thrown away. That's at most 55 values in 256,
/// so one v4 covers a handful of dice and another is minted when it runs out.
///
/// `check` has already bounded both arguments. The guard here stops a `sides`
/// of 0 dividing by zero if this is ever called from somewhere that hasn't been
/// through `check`.
fn roll(sides: u8, count: u8) -> Vec<u8> {
    if sides == 0 {
        return Vec::new();
    }
    let limit = 256 - (256 % sides as u16);
    let mut faces = Vec::with_capacity(count as usize);
    let mut bytes = Vec::new();
    while faces.len() < count as usize {
        let byte = match bytes.pop() {
            Some(byte) => byte,
            None => {
                bytes.extend_from_slice(Uuid::new_v4().as_bytes());
                continue;
            }
        };
        if (byte as u16) < limit {
            faces.push(byte % sides + 1);
        }
    }
    faces
}

/// How a throw reads in the log.
///
/// One die is `d20 → 17`; a handful is `3d6 → 4, 1, 6 (11)`. The individual
/// dice are always shown, so the total is a convenience and can't hide a
/// number. The total isn't a modifier or a rule either: knowing that 4 and 1
/// and 6 make 11 isn't knowing what a hit point is, and adding up eight of
/// them by hand is the tedious part of a fireball.
///
/// The room writes this, not the client, for the same reason as
/// `ChatLine::rolled`: the throw happens here so that everybody reads the same
/// sentence about it.
fn rolled_text(sides: u8, faces: &[u8]) -> String {
    if let [only] = faces {
        return format!("d{sides} → {only}");
    }
    let dice: Vec<String> = faces.iter().map(|face| face.to_string()).collect();
    let total: u32 = faces.iter().map(|face| u32::from(*face)).sum();
    format!("{}d{sides} → {} ({total})", faces.len(), dice.join(", "))
}

/// The permission rule for erasing. The DM may clear anything; everyone else may
/// take back what they drew.
///
/// This is the only thing in the room a player may destroy, and the only reason
/// `Shape::by` is stored. It's a different rule from `can_move`: a shape is
/// nobody's to move, and nothing but this asks who drew one.
fn can_erase(client: &Client, shape: &Shape) -> bool {
    match &client.identity {
        Identity::Dm => true,
        Identity::Player(id) => matches!(&shape.by, Owner::Player(by) if by == id),
    }
}

/// The permission rule for movement. Creating, deleting and editing a token
/// (including reassigning its `owner`) are DM-only and checked in `check`.
fn can_move(client: &Client, token: &Token) -> bool {
    match &client.identity {
        Identity::Dm => true,
        Identity::Player(id) => matches!(&token.owner, Owner::Player(owner) if owner == id),
    }
}

/// Whether this identity is one of the two ends of a line somebody said.
///
/// **This is the entire visibility rule for the chat log, and it's about two
/// people, not a role.** A message to the table is everybody's. A whisper
/// exists in two copies, the sender's and the recipient's, which is why this
/// checks `by` as well as `to`: without that, the DM's own whisper to Saelyn
/// would be missing from the DM's log.
///
/// It takes an `Identity`, not a `Client`, because both callers have one and
/// neither has the other: `snapshot_for` is handed an identity, and
/// `message_for` looks one up per recipient.
///
/// A free function like `can_move` and `can_erase`, because it needs nothing
/// from the room. `shape_seen` is on `RoomState` because it has to ask where
/// the party is standing; this asks nothing of the board.
fn party_to(identity: &Identity, line: &ChatLine) -> bool {
    let is = |owner: &Owner| is_owner(identity, owner);
    match &line.to {
        // Not filtered at all. The fog doesn't apply to chat.
        ChatTo::Table => true,
        ChatTo::Dm => matches!(identity, Identity::Dm) || is(&line.by),
        ChatTo::Player(id) => matches!(identity, Identity::Player(me) if me == id) || is(&line.by),
    }
}

/// Whether this identity is the person that `Owner` names.
///
/// Shared because two features ask it for different reasons: `party_to` asks
/// it about the ends of a whisper, and `notes_for` asks it about the only
/// scratchpad a client may hold. It's the inverse of `drawn_by` and a free
/// function for the same reason: it needs nothing from the room.
fn is_owner(identity: &Identity, owner: &Owner) -> bool {
    match (identity, owner) {
        (Identity::Dm, Owner::Dm) => true,
        (Identity::Player(me), Owner::Player(them)) => me == them,
        _ => false,
    }
}

/// The roster isn't persisted: it's a constant, and a saved copy could only
/// disagree with it. It would have to become state if the DM could edit it.
///
/// Each room has its own roster constant. A `RoomState` is handed its roster,
/// so a slug that names a slot in one room names nothing in another. `hello`
/// already refuses a `player_id` that isn't in `self.roster`, so that
/// isolation needs no extra code. See the handshake tests.
fn roster_from(slots: &[(&str, &str)]) -> Vec<RosterEntry> {
    slots
        .iter()
        .map(|(id, name)| RosterEntry {
            id: PlayerId::new(id),
            name: (*name).to_owned(),
        })
        .collect()
}

impl RoomState {
    /// A room holding nothing, and the base `restored` and `blank` build on.
    ///
    /// The fields set here are the ones a `Saved` does not describe: who the DM
    /// is, the cast list, the undo ring and the two client tables. Everything
    /// else is a placeholder, and `adopt` writes over all of it.
    fn empty(dm_secret: String, roster: Vec<RosterEntry>) -> Self {
        Self {
            dm_secret,
            roster,
            map: MapInfo::default(),
            staged: None,
            tokens: HashMap::new(),
            initiative: Initiative::default(),
            shapes: Vec::new(),
            walls: Vec::new(),
            revealed: HashSet::new(),
            known: HashSet::new(),
            visible: HashSet::new(),
            shown: HashSet::new(),
            overrides: HashMap::new(),
            show_names: true,
            diagonals: Diagonals::Equal,
            show_cursors: true,
            show_dm_cursor: true,
            backdrop: None,
            audio: None,
            calibrations: HashMap::new(),
            undo: VecDeque::new(),
            chat: VecDeque::new(),
            notes: HashMap::new(),
            colours: Colours::new(),
            clients: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    /// A room off disk. Everything the file does not carry (the DM secret, the
    /// roster, who is connected) comes from the environment or starts empty.
    fn restored(saved: Saved, dm_secret: String, roster: Vec<RosterEntry>) -> Self {
        let mut state = Self::empty(dm_secret, roster);
        state.adopt(saved);
        state.floor();
        state
    }

    /// A room with no save on disk and no demo content: an empty board with a
    /// cast standing by.
    ///
    /// `restored` with nothing to adopt. It's a separate constructor, not a flag
    /// on `hardcoded`, because the two answer different questions: `hardcoded`
    /// is what a fresh checkout looks like, so there is something on the
    /// screen, and this is what a new room looks like. Seeding a Halloween
    /// one-shot with the campaign's party is worse than seeding it with nothing.
    /// Ends in `floor`, like the other constructors.
    ///
    /// **It keeps the built-in map.** `MapInfo::default` has no URL, and a
    /// client handed one can't load an image, never builds its stage and draws
    /// nothing: a new room would open as a black page with a working rail on it.
    /// The map is the placeholder the DM's first `SetMap` replaces, as in the
    /// primary room. Everything that would need clearing (tokens, walls, fog,
    /// initiative) is still empty.
    fn blank(dm_secret: String, roster: Vec<RosterEntry>) -> Self {
        let mut state = Self::empty(dm_secret, roster);
        state.map.url = BUILT_IN_MAP.to_owned();
        state.floor();
        state
    }

    /// Puts the room as it stands on the undo ring as the entry nothing goes
    /// back past.
    ///
    /// **Every constructor ends with this, not `spawn`.** (`recompute_sight` is
    /// different: it's derived from state, so `spawn` does it once.) Without a
    /// floor, the room's first command can't be undone: the step it pushes
    /// becomes the bottom of the ring, and `undo_label` reports there is
    /// nowhere to go. Doing it here means a `RoomState` built by hand, which is
    /// every test in this crate, follows the same rule as the server.
    fn floor(&mut self) {
        self.remember("loaded the room");
    }

    /// Takes a `Saved` as the truth for everything it describes, leaving
    /// everything it does not alone.
    ///
    /// **The only inverse of `to_saved`.** Booting from disk and undoing are the
    /// same operation on the same definition of state, so they share this
    /// instead of each listing the fields. With two lists, a field added to
    /// `Saved` and read in only one of them loads correctly and undoes to a
    /// stale value, or the reverse.
    ///
    /// It doesn't touch what a `Saved` doesn't describe: `dm_secret`, `roster`,
    /// `clients`, `pending`, and the ring itself. Leaving those alone is what
    /// makes undo safe. Restoring the socket table from ten commands ago would
    /// hand the room clients that have since disconnected, and restoring the
    /// ring would make a second undo walk back into history already rewound.
    fn adopt(&mut self, saved: Saved) {
        self.map = saved.map;
        // The one field on the file whose shape changed instead of gaining a
        // sibling, which is why `StagedView` flattens its map. See the test
        // named for an older save.
        self.staged = saved.staged.map(|staged| StagedBoard {
            map: staged.map,
            walls: staged.walls,
            overrides: fog::unpack_overrides(&staged.overrides),
        });
        self.tokens = saved
            .tokens
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        self.initiative = saved.initiative;
        self.shapes = saved.shapes;
        self.walls = saved.walls;
        self.revealed = fog::unpack(&saved.revealed);
        // Both are derived from where the tokens stand and what the DM painted,
        // which the same `Saved` holds, so they are recomputed, not restored.
        // That stops a save written before a door was shut from describing
        // sight through it, and it's why every caller of this is followed by
        // `recompute_sight`.
        self.known = HashSet::new();
        self.visible = HashSet::new();
        // Restored whole, unlike the two above. Sight is derived from what the
        // file already holds; what the DM decided is not derivable from
        // anything, so losing it would lose the work.
        self.overrides = fog::unpack_overrides(&saved.overrides);
        self.show_names = saved.show_names;
        self.diagonals = saved.diagonals;
        self.show_cursors = saved.show_cursors;
        self.show_dm_cursor = saved.show_dm_cursor;
        self.backdrop = saved.backdrop;
        self.calibrations = saved.calibrations;
        // Restored here like everything else, because two field lists would be
        // the trap `docs/undo.md` names: a field read in `restored` and
        // forgotten in the undo arm loads correctly and undoes to a stale
        // value, and neither shows up as an error.
        //
        // **The undo arm exempts the scratchpads, not this function.** Boot
        // wants them back and a restore doesn't. Saying so once, at the call
        // site that means it, keeps this function the single answer to "what
        // is a saved room".
        self.notes = saved
            .notes
            .into_iter()
            .map(|note| (note.by, note.text))
            .collect();
        // Exempted in the undo arm like the notes, for the same reason: boot
        // wants these back, an undo does not.
        self.colours = saved.colours;
    }

    fn to_saved(&self) -> Saved {
        let mut tokens: Vec<Token> = self.tokens.values().cloned().collect();
        // Same reason `snapshot_for` sorts: `HashMap` order varies per process,
        // so without this the file churns on every save and every restart.
        tokens.sort_by(|a, b| a.id.cmp(&b.id));

        Saved {
            map: self.map.clone(),
            staged: self.staged.as_ref().map(StagedBoard::view),
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
            show_cursors: self.show_cursors,
            show_dm_cursor: self.show_dm_cursor,
            backdrop: self.backdrop.clone(),
            calibrations: self.calibrations.clone(),
            // Sorted like the tokens: `HashMap` order varies per process, and an
            // unsorted list would rewrite the whole file every time anybody
            // typed.
            notes: {
                let mut notes: Vec<SavedNote> = self
                    .notes
                    .iter()
                    .map(|(by, text)| SavedNote {
                        by: by.clone(),
                        text: text.clone(),
                    })
                    .collect();
                notes.sort_by(|a, b| a.by.cmp(&b.by));
                notes
            },
            // Nothing to sort and nothing to convert: a `BTreeMap` is already
            // both the room's shape and the file's, because `PlayerId` is a
            // legal JSON key. The notes above need a list for want of one.
            colours: self.colours.clone(),
        }
    }

    /// Puts the room as it stands now on the undo ring, labelled with what was
    /// just done to it.
    ///
    /// Called *after* the change, which makes the back of the ring the present.
    /// Don't snapshot before every command and discard it when nothing came of
    /// it: that clones the whole room on every drag frame, thirty times a
    /// second from each of six people, to keep one.
    fn remember(&mut self, did: &str) {
        self.undo.push_back(Snapshot {
            did: did.to_owned(),
            state: self.to_saved(),
        });
        // One more than the number of undos, because the back of the ring is
        // where the DM already is, not somewhere to go back to.
        while self.undo.len() > MAX_UNDO + 1 {
            self.undo.pop_front();
        }
    }

    /// What the DM's undo would take back, or `None` when the ring holds only
    /// the state they are in.
    fn undo_label(&self) -> Option<String> {
        if self.undo.len() < 2 {
            return None;
        }
        self.undo.back().map(|snapshot| snapshot.did.clone())
    }

    /// The room a first boot starts from, with no save on disk yet. The DM
    /// replaces the map from the browser.
    ///
    /// **Only for the primary room's first boot.** It names `ROSTER` directly
    /// instead of taking a cast, because the tokens below are that roster
    /// written out: a version that took any roster would put tokens called
    /// Cleodara and Saelyn on somebody else's board. Every other room starts
    /// at `blank`.
    fn hardcoded(dm_secret: String) -> Self {
        // The art is named separately, not derived from the name: a character
        // called "Captain Bronzebeard" is a file called `bronzebeard.png`. These
        // are stand-ins anyway; the real portraits are picked out of the
        // library onto whichever tokens end up being used.
        let party = |id: &'static str| Owner::Player(PlayerId::new(id));
        // Built below, then floored at the end like the other constructors.
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
            // Not t6: the tests name the two monsters below by id, so the
            // newest slot takes the next free id and nothing is renumbered.
            ("t8", "Ignacio", "ignacio", 6.5, 3.5, party("ignacio")),
            ("t6", "Ogre", "ogre", 14.5, 9.5, Owner::Dm),
            ("t7", "Wraith", "wraith", 21.5, 4.5, Owner::Dm),
        ];

        let mut state = Self {
            dm_secret,
            roster: roster_from(&ROSTER),
            map: MapInfo {
                url: BUILT_IN_MAP.to_owned(),
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
            shown: HashSet::new(),
            overrides: HashMap::new(),
            // On. A first boot is a room with eight named tokens and nothing
            // else to tell them apart yet.
            show_names: true,
            // Every step costs one cell, diagonal or not: the ruler's default.
            diagonals: Diagonals::Equal,
            // On, because a feature that ships off is one a table never
            // discovers.
            show_cursors: true,
            // On, for the same reason.
            show_dm_cursor: true,
            // Nothing in front of the table, the same as a room saved before
            // this field existed.
            backdrop: None,
            audio: None,
            calibrations: HashMap::new(),
            undo: VecDeque::new(),
            chat: VecDeque::new(),
            notes: HashMap::new(),
            // Empty, so every slot draws in the default its roster position
            // gives it, as in a room saved before this table existed.
            colours: Colours::new(),
            clients: HashMap::new(),
            pending: HashMap::new(),
        };
        state.floor();
        state
    }

    /// Returns whether the room now holds a change worth writing to disk.
    fn handle(&mut self, origin: ClientId, msg: ClientMsg) -> bool {
        // The handshake is the one thing an unidentified connection may do, so
        // it runs ahead of the permission check instead of through it.
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
        // Before, because the fog decides whether the table can see a token,
        // and `apply` plus the recompute that follows will have overwritten
        // both halves of that by the time anything asks. It's the same problem
        // `was_unseen` solves, spanning the whole command instead of one field
        // on one token.
        //
        // Only for some commands, because this costs a set and a packed string,
        // and a drag frame arrives thirty times a second from each of six people.
        let before = moves_sight(&msg).then(|| self.sight_now());
        // Read before `apply` because this describes the command, and `apply`
        // consumes it.
        let did = undid(&msg);

        let mut events = self.apply(origin, msg);
        if let Some(before) = before {
            let more = self.refresh_fog(before, &events);
            events.extend(more);
        }

        let dirty = events.iter().any(persists);
        // **A step is a command with a label that changed something.** Both
        // halves matter: `persists` alone would record an undo as a step to
        // undo, and a label alone would record a `SetMap` that was refused
        // deeper in `apply` than `check` could see.
        //
        // After the fog, because the snapshot is the room as it now stands and
        // `refresh_fog` may have grown `revealed`. That set is on disk, so a
        // snapshot taken before it would restore the party's memory to one drop
        // earlier every time.
        if let Some(did) = did.filter(|_| dirty) {
            self.remember(did);
            events.push(Event::UndoChanged);
        }

        self.dispatch(origin, &events);
        dirty
    }

    /// Resolve a connection's identity. A DM secret wins; otherwise a
    /// `player_id` is accepted only if it names a live roster slot, so a stale
    /// `localStorage` value from a since-edited roster falls back to the picker
    /// instead of becoming an identity nobody owns.
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
        // After the insert, so the list includes whoever just arrived, on their
        // own screen too. The `Welcome` above carried the same list through
        // `snapshot_for`. That's invariant 3, not a duplicate, and the second
        // one costs a repaint of the same chips.
        //
        // `refresh_pickers` tells the undecided which *slots* are taken; this
        // tells the table which *people* are here. Both are the socket table
        // changing, not the room, which is why this returns nothing to save.
        self.dispatch(origin, &[Event::PresenceChanged]);
    }

    /// A slot is claimed while someone is connected as it. Nothing persists:
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

    /// Who is connected, the DM among them.
    ///
    /// Not the same answer as `roster_slots`. That one describes *slots*, for
    /// somebody choosing one; this describes *people*, for everybody who
    /// already has. The difference is the DM, who occupies no slot and is the
    /// connection a table most wants to be sure of.
    ///
    /// **Deduplicated.** One person on a laptop and a phone is legitimate (as
    /// `RosterSlot::claimed` already allows), so two sockets are one name here.
    /// Counting sockets would put seven people at a table of six.
    ///
    /// Ordered: the DM, then the roster's own order. Nothing downstream depends
    /// on it (the strip draws every slot and dims the absent ones, so it never
    /// reflows), but a list whose order varied per process would make a test
    /// assert on `HashMap` iteration.
    fn here(&self) -> Vec<Owner> {
        let mut here = Vec::new();
        if self.clients.values().any(|c| c.identity == Identity::Dm) {
            here.push(Owner::Dm);
        }
        for entry in &self.roster {
            let claimed = self
                .clients
                .values()
                .any(|c| c.identity == Identity::Player(entry.id.clone()));
            if claimed {
                here.push(Owner::Player(entry.id.clone()));
            }
        }
        here
    }

    /// How this room is doing, for `/api/status`.
    ///
    /// `unsaved` is passed in because the debounce deadline lives in `run` and
    /// not on the state. Everything else is counted off `&self` here, and
    /// `here()` is called, not reimplemented, so the status page and the
    /// presence strip can never disagree about who is connected.
    fn status(&self, unsaved: bool, health: &SaveHealth) -> RoomStatus {
        RoomStatus {
            here: self.here(),
            // Both tables, because a socket that has not said who it is yet is
            // still a socket the box is holding open.
            sockets: self.clients.len() + self.pending.len(),
            tokens: self.tokens.len(),
            unsaved,
            saves_failing: health.failing,
            last_saved_unix: health.last_ok_unix,
        }
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

    /// Invariant 3. Some fields are withheld whole (the staged map, the walls);
    /// others are withheld from inside something the table does see (hidden
    /// tokens, hit points).
    ///
    /// Every route out of the room narrows here in the same three ways a delta
    /// does: a hidden token is dropped, what survives is redacted through
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
            // One `None` withholds the next dungeon's map, walls and paint
            // together. Keep them bundled: a second staged field is one a later
            // change could add and forget to filter here.
            staged: match identity {
                Identity::Dm => self.staged.as_ref().map(StagedBoard::view),
                Identity::Player(_) => None,
            },
            tokens,
            initiative: self.initiative_for(is_dm),
            shapes: self.shapes_for(is_dm),
            // All of them or none, with no middle case to get wrong. A wall is
            // the dungeon's floor plan, and a player infers it from the edges of
            // the fog instead of reading it out of their snapshot. Empty is also
            // what a map nobody has traced looks like.
            walls: if is_dm {
                self.walls.clone()
            } else {
                Vec::new()
            },
            // The same value for everyone. Fog is party-shared, so there is one
            // answer; the DM is sent it so their board can draw, faintly, what
            // the table is looking at. The walls above stay the DM's alone, and
            // a player reads the geometry off the edges of this instead.
            fog: self.fog_for(),
            // DM-only, like the walls: this is what the DM decided, and `fog`
            // is what the table gets to see of it. Empty is both "nothing
            // painted" and "you are not the DM".
            overrides: if is_dm {
                self.overrides_for(false)
            } else {
                OverrideView::default()
            },
            // The room-wide settings below go to everyone. A board labelled
            // differently on different screens says nothing useful.
            show_names: self.show_names,
            // A counting convention half the table holds is worse than either
            // convention.
            diagonals: self.diagonals,
            // The client also reads this to decide whether to *send*, so a join
            // that omitted it would leave every fresh page shipping its pointer
            // into a room that has switched cursors off.
            show_cursors: self.show_cursors,
            // A player is sent this and does nothing with it. What reads it back
            // is the DM's own panel, on a second tab or after a refresh.
            show_dm_cursor: self.show_dm_cursor,
            // Nothing here to keep from anybody. A join that omitted it would
            // put a fresh page back on the board while the rest of the table
            // looked at the campfire.
            backdrop: self.backdrop.clone(),
            audio: self.audio.clone(),
            // Neither is anybody's secret: the table should see whether the DM
            // is still there, and six other screens draw your ring in the
            // colour you chose.
            here: self.here(),
            colours: self.colours.clone(),
            // The DM's next undo, and `None` for everybody else. A player has no
            // button for it to label, and `None` is also what an untouched room
            // says, so the two can't be told apart (like an empty wall list).
            undo: if is_dm { self.undo_label() } else { None },
            // Filtered by *which person*, not by whether they are the DM.
            // `is_dm` can't answer it and isn't asked: a whisper between the DM
            // and Saelyn is Saelyn's as much as the DM's.
            chat: self.chat_for(identity),
            // Also filtered by which person. A whisper has two ends and the DM
            // is one end of all of them; a scratchpad has one end, and the DM
            // has no standing in anybody's but their own.
            notes: self.notes_for(identity),
        }
    }

    /// This client's own scratchpad, and nothing else.
    ///
    /// **The only `*_for` on this impl that gives the DM less than the room
    /// holds.** Every other one narrows for a player and hands the DM all of
    /// it. There is no `is_dm` here, and adding one would delete the feature:
    /// nobody writes freely in a box somebody else can read.
    ///
    /// Invariant 3 is why this is a function and not a field read at the call
    /// site: a join and a restore both come through here, so there is no
    /// second place for the whole table's notes to escape from.
    fn notes_for(&self, identity: &Identity) -> String {
        self.notes
            .iter()
            .find(|(owner, _)| is_owner(identity, owner))
            .map(|(_, text)| text.clone())
            .unwrap_or_default()
    }

    /// Whether `identity` may address `to` at all.
    ///
    /// **The permission `Say` and `Roll` share, and a rule about a destination,
    /// not a role.** It never asks whether this is the DM in order to grant
    /// something, only to say which of the two lists of destinations is
    /// theirs. Nobody may name another player; that is the boundary of the
    /// feature.
    ///
    /// The DM addressing themselves isn't decided here, because the two
    /// callers disagree: `Say` refuses it and `Roll` allows it. Both handle
    /// that case before reaching this.
    ///
    /// The refusals are worded as the boundary, not as a restriction: a player
    /// whose message bounces should learn that Slate doesn't do this, not that
    /// they lack a permission somebody else has.
    fn may_address(&self, identity: &Identity, to: &ChatTo) -> Result<(), String> {
        match (identity, to) {
            // The one everybody has, and the second one a player has.
            (_, ChatTo::Table) => Ok(()),
            (Identity::Player(_), ChatTo::Dm) => Ok(()),
            // The DM addressing one player, which is the only reason this
            // variant exists. It must name a real slot, so a whisper can't be
            // addressed into nowhere.
            (Identity::Dm, ChatTo::Player(id)) => {
                if self.roster.iter().any(|entry| &entry.id == id) {
                    Ok(())
                } else {
                    Err("nobody by that name is at this table".to_owned())
                }
            }
            // Player to player, which this feature never allows.
            (Identity::Player(_), ChatTo::Player(_)) => {
                Err("you can whisper the DM or shout to the table".to_owned())
            }
            // Handled by both callers before they get here, and differently.
            (Identity::Dm, ChatTo::Dm) => {
                Err("you are the DM — shout, or whisper a player".to_owned())
            }
        }
    }

    /// Put a line in the log and tell whoever is party to it.
    ///
    /// Shared by `Say` and `Roll` so that the cap, the trim and the event are
    /// written once. What decides *who hears it* is downstream, in `party_to`.
    fn log(&mut self, line: ChatLine) -> Vec<Event> {
        self.chat.push_back(line.clone());
        // From the front: the cap limits how much of the evening is kept, and
        // the oldest lines are the ones nobody is looking for any more.
        while self.chat.len() > MAX_CHAT_LINES {
            self.chat.pop_front();
        }
        vec![Event::Said { line }]
    }

    /// This session's talk as this recipient may see it.
    ///
    /// **Two clients get two different conversations out of this, not one
    /// conversation with rows missing.** Every other `*_for` on this impl
    /// narrows the room's single copy of something. Here the room's copy is a
    /// pile of private exchanges that no client is entitled to whole, the DM
    /// included: they see every whisper because they are one end of all of
    /// them, not because they are the DM.
    ///
    /// Invariant 3 matters most here: filtering the deltas and forgetting this
    /// would hand a joining player the whole evening's whispers in one frame.
    fn chat_for(&self, identity: &Identity) -> Vec<ChatLine> {
        self.chat
            .iter()
            .filter(|line| party_to(identity, line))
            .cloned()
            .collect()
    }

    /// The drawings as this recipient may see them.
    ///
    /// The DM gets every shape; a player gets the ones `shape_seen` allows.
    ///
    /// A shape whose anchor isn't in the room can't happen (deleting a token
    /// takes its shapes), and is withheld anyway, so this fails closed.
    fn shapes_for(&self, is_dm: bool) -> Vec<Shape> {
        self.shapes
            .iter()
            .filter(|shape| is_dm || self.shape_seen(shape))
            .cloned()
            .collect()
    }

    /// Whether the table may see this shape at all.
    ///
    /// The two arms ask different questions. **An anchored shape follows its
    /// token's visibility:** an aura on a monster in the dark is that monster's
    /// position drawn in colour, and it goes wherever the monster goes.
    ///
    /// An unanchored shape is ground, so it gates on `known`, not `visible`. The
    /// marker a player dropped in a corridor is still theirs after they walk
    /// out of it, and gating on current sight would make every shape on the
    /// board flicker as the party moved. It's the split `docs/fog.md` draws
    /// between terrain and creatures.
    ///
    /// `known` and not `revealed`, so a circle drawn on ground the DM has
    /// painted over is treated the way that ground is: handed over with an
    /// `Explored` fill, and taken away again with a `Dark` one.
    ///
    /// The `map.fog` guard isn't a shortcut. `known` is empty on an unfogged
    /// map, so without it every loose shape in the room would vanish from every
    /// player's board the moment fog was switched off.
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

    /// Whether anything drawn follows this token, which decides whether hiding
    /// or deleting it has to rebuild anyone's board.
    ///
    /// Gating on it matters: emitting `ShapesChanged` every time a token is
    /// hidden would tell the table that *something happened* on every hide,
    /// which they aren't entitled to know. The initiative panel follows the
    /// same rule.
    fn anchors_a_shape(&self, id: &TokenId) -> bool {
        self.shapes.iter().any(|s| s.anchor() == Some(id))
    }

    /// The turn order as this recipient may see it: rows naming a token they
    /// cannot see are gone, and `current` with them.
    ///
    /// Dropping the row isn't cosmetic. The panel names its rows by looking the
    /// token up in the scene, so a row the client has no token for draws as a
    /// raw id: a monster the DM hid, advertised by the one panel that is always
    /// on screen. `current` goes for the same reason, since an id is data. The
    /// table sees the round advance past somebody they can't see, which is what
    /// is happening.
    fn initiative_for(&self, is_dm: bool) -> Initiative {
        if is_dm {
            return self.initiative.clone();
        }

        let unseen = |token: &TokenId| {
            // An entry naming no token can't happen (deleting a token takes its
            // row), but treating it as visible keeps this total either way. Nor
            // can one name a staged-only token, which `check` refuses; the
            // predicate covers it anyway instead of depending on that.
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

    /// **Whether the table can't see this token: the one question every filter
    /// in this file asks.**
    ///
    /// Two of the three reasons are facts about the token and live in
    /// `Token::unseen`: `hidden` is a creature the DM took off the board,
    /// `staged_only` is one that was never on it. The third is a fact about the
    /// *room* (where the walls are, where the party stands, how far their
    /// torches reach), so it can't be answered from `&Token` alone. That's why
    /// this lives on `RoomState`.
    ///
    /// Every filter has to ask about all three. Anything that calls
    /// `Token::unseen` directly filters on two of them and leaks.
    fn unseen_by_table(&self, token: &Token) -> bool {
        token.unseen() || !self.in_sight(token)
    }

    /// Whether the party has line of sight on this token.
    ///
    /// A player's own token is always in sight. It's a vision source, so the
    /// cell it stands in is lit by it anyway; saying so directly costs one
    /// branch, and means a token the DM hands over mid-fight doesn't depend on
    /// the recompute having already run.
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

    /// Whether this recipient may be shown a pointer at `at`.
    ///
    /// Asymmetric. The DM sees every pointer, because they can see the whole
    /// board already. A *player's* pointer is relayed wherever it goes, because
    /// a player can only point at what their own client drew. An unfogged map
    /// has nothing to withhold. What's left is the DM's pointer over ground the
    /// party hasn't explored, the one case worth filtering: the DM's hand
    /// lingers where the DM is working, which is over the ambush in the unlit
    /// chamber.
    ///
    /// `known` and not `visible`, the same split every other reader of the fog
    /// makes: a pointer is over the terrain, so it goes with the explored map
    /// and not with the creatures. It therefore follows the fringe and the DM's
    /// own mask too: a room the DM has painted `Dark` hides their pointer as
    /// well.
    ///
    /// `show_dm_cursor` widens the same case: the fog decides *where* the DM's
    /// pointer is withheld, and the switch says "everywhere". It's read after
    /// the two early yeses and before the `map.fog` guard, so it works on an
    /// unfogged map, which is mostly when a DM would reach for it.
    ///
    /// The `map.fog` guard is the same as `shape_seen`'s: `known` is empty on an
    /// unfogged map, so without it the DM's pointer would vanish from every
    /// player's board the moment fog was switched off.
    fn cursor_seen(&self, by: &Owner, at: Pos, to_dm: bool) -> bool {
        if to_dm || !matches!(by, Owner::Dm) {
            return true;
        }
        // A DM who has put their pointer away is withheld from a player
        // everywhere, not only over the dark. It's read here and not in `check`
        // because it governs what one hand at the table shows, not what any
        // client may send.
        if !self.show_dm_cursor {
            return false;
        }
        if !self.map.fog {
            return true;
        }
        let px = fog::grid_to_px(&self.map, at.x, at.y);
        self.known.contains(&fog::cell_of(&self.map, px))
    }

    /// Where the party is looking from, in grid units.
    ///
    /// Vision comes from tokens a player *owns*, so handing one over grants sight
    /// with no extra rule and taking it back removes it. A player's token the DM
    /// has hidden grants none: it is off the board as far as the table is
    /// concerned, and a creature nobody can see lighting the room for everybody
    /// would be hard to explain.
    ///
    /// Asks `Token::unseen`, not `unseen_by_table`, which would be circular:
    /// what the party can see can't be an input to computing what the party
    /// can see.
    ///
    /// Each source carries its own reach: `light_ft` if the token has one and
    /// the map's `vision_ft` if not. `fog::Source` holds that fallback, so this
    /// copies one field instead of spelling out the rule here and in
    /// `sight_sources`.
    fn party_sources(&self) -> Vec<fog::Source> {
        Self::ordered(
            self.tokens
                .values()
                .filter(|t| matches!(t.owner, Owner::Player(_)) && !t.unseen())
                .map(|t| fog::Source {
                    at: Pos { x: t.x, y: t.y },
                    radius_ft: t.light_ft,
                })
                .collect(),
        )
    }

    /// `HashMap` order varies per process and the sweeps short-circuit on cells
    /// another source already lit. The answer is the same either way, but two runs
    /// of the same room should do the same work.
    fn ordered(mut sources: Vec<fog::Source>) -> Vec<fog::Source> {
        sources.sort_by(|a, b| {
            (a.at.x, a.at.y)
                .partial_cmp(&(b.at.x, b.at.y))
                .unwrap_or(Ordering::Equal)
        });
        sources
    }

    /// Everything lighting the live board: the party, plus whichever lights they
    /// can see. This is the one place the gate lives.
    ///
    /// **A light nobody is carrying is gated on line of sight, not on reach.**
    /// Ungated, promoting a prepared dungeon with a brazier in each room hands
    /// the table every lit chamber on the level through the walls, because
    /// `visible` is a flat union of its sources. Gated on the party's *radius*,
    /// it's wrong the other way: a brazier forty feet off is one the party can
    /// plainly see with torches that reach thirty. So the question is
    /// `fog::in_line_of_sight`, which asks only about geometry, and the
    /// fallback beside it is the party's own sight, which covers
    /// `Lighting::Room`, where a flood reaches round a corner no straight line
    /// does.
    ///
    /// No cascade. The gate reads the sight the party has on their own,
    /// computed before any light joins the list, so one brazier can never
    /// switch on the next. Otherwise a chain of torches down a corridor would
    /// open the level one step at a time.
    ///
    /// A token's whole footprint is asked about, as `in_sight` does, so a
    /// four-cell brazier leaning into the light counts. See `docs/fog.md`.
    fn sight_sources(&self) -> Vec<fog::Source> {
        let mut sources = self.party_sources();

        let lights: Vec<&Token> = self
            .tokens
            .values()
            .filter(|t| t.light_ft.is_some() && !matches!(t.owner, Owner::Player(_)) && !t.unseen())
            .collect();
        // The common case: one sweep, no gate.
        if lights.is_empty() {
            return sources;
        }

        let reached = fog::sight_cells(&self.map, &self.walls, &sources);
        let active: Vec<fog::Source> = lights
            .into_iter()
            .filter(|t| {
                fog::in_line_of_sight(&self.map, &self.walls, &sources, Pos { x: t.x, y: t.y })
                    || fog::covered_cells(t.x, t.y, t.size)
                        .iter()
                        .any(|cell| reached.contains(cell))
            })
            .map(|t| fog::Source {
                at: Pos { x: t.x, y: t.y },
                radius_ft: t.light_ft,
            })
            .collect();

        sources.extend(Self::ordered(active));
        sources
    }

    /// Recomputes what the party can see and applies the DM's overrides over the
    /// top.
    ///
    /// Three sets come out of one reading. The map decides which question that
    /// reading asks (`fog::sight_cells` casts rays on a `Dynamic` map and floods
    /// rooms on a `Room` one), and nothing below this line knows which. The
    /// mode changes what the party can see, not what any of it means, so it
    /// needs no arm here, no arm in `message_for` and no third derived set.
    ///
    /// **Only the rays reach `revealed`**, and the mask makes the other two:
    ///
    /// ```text
    /// revealed ∪= rays                          // memory, persisted, rays only
    /// visible   = rays  ∪ Lit − Dark            // in sight now
    /// known     = fringe(revealed) ∪ Lit ∪ Explored − Dark   // shown as terrain
    /// ```
    ///
    /// The fringe is one cell of terrain past everywhere the rays reached. It's
    /// a mask over `revealed` for the same reason the overrides are: memory is
    /// rays only, so the widening is recomputed from it every time instead of
    /// written into it, can't be baked into a save, and lifts the moment the
    /// grid moves under it. `with_fringe` in `fog.rs` says what it is for.
    ///
    /// Because nothing but a ray enters memory, one `match` arm per cell
    /// settles both derived sets, and a cell holds only one override, so the
    /// loop below has no order to get wrong. It also means clearing a paint
    /// undoes it: `Explored` and `Dark` never write to `revealed`. Don't make
    /// either one write to it. See `docs/fog.md`.
    ///
    /// `visible ⊆ known` holds (`fringe(revealed) ⊇ revealed ⊇ rays`, and the
    /// mask does the same thing to both), which lets `FogView` pack both facts
    /// into one character per cell. `with_fringe` inserts each input cell
    /// before it checks the board, which is what guarantees the first `⊇`.
    ///
    /// Nothing downstream asks about an override: `in_sight` reads `visible`
    /// and gets a different answer.
    ///
    /// An unfogged map has neither set and no mask. Turning fog off shouldn't
    /// leave a stale bitset behind, and a map that gets fog turned back on
    /// should start from where the party is now. The overrides survive it
    /// (they are what the DM said, not derived) and apply again the moment fog
    /// comes back.
    fn recompute_sight(&mut self) {
        if self.map.fog {
            let rays = fog::sight_cells(&self.map, &self.walls, &self.sight_sources());

            self.revealed.extend(rays.iter().copied());
            self.known = fog::with_fringe(&self.map, &self.revealed);
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
        } else {
            self.visible.clear();
            self.known.clear();
        }

        // Last, and after both branches instead of inside the fogged one: an
        // unfogged map shows the table every token, and a room that has just had
        // its fog switched off has to record that as much as one that recomputed
        // a raycast.
        //
        // **This is the only moment the room and what the table holds agree**,
        // which is why it's written down here instead of being asked for later.
        // Everything that can change the answer recomputes (`moves_sight` lists
        // it) except a drag frame, and a drag frame is the case this exists to
        // survive.
        let shown = self
            .tokens
            .values()
            .filter(|t| !self.unseen_by_table(t))
            .map(|t| t.id.clone())
            .collect();
        self.shown = shown;
    }

    /// Forgets the dungeon: the party's memory and both sets derived from it.
    ///
    /// One call instead of three lines in several places, because the third set
    /// is the one that gets missed. A `known` left standing after `revealed` is
    /// cleared is the entire map still sitting on the table's board.
    ///
    /// Emits nothing. Every caller is followed by `refresh_fog`, which compares
    /// against a reading taken before any of it, so the clear is already in the
    /// difference it reports.
    fn forget_fog(&mut self) {
        self.revealed.clear();
        self.known.clear();
        self.visible.clear();
    }

    /// The fog as it goes on the wire, or `None` on a map with fog turned off.
    /// Like `staged` being `None`, the client can't tell that apart from a map
    /// that has none.
    fn fog_for(&self) -> Option<FogView> {
        self.map.fog.then(|| fog::pack(&self.known, &self.visible))
    }

    /// Whether a connected client is the DM. `message_for` holds `&self` and a
    /// recipient id, not a `Client`, so the lookup lives here.
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
    /// This doesn't tell the server the DM is previewing; preview stays
    /// client-only. It's the rule `PromoteStaged` and `ClearStaged` follow:
    /// staged token state belongs to the staged map, so without one there is
    /// nothing for it to belong to. Allowing it would mint a token absent from
    /// the live board with no staged board to appear on either, which nobody,
    /// the DM included, could reach.
    fn staged_slot(&self, what: &str) -> Result<(), String> {
        if self.staged.is_some() {
            Ok(())
        } else {
            Err(format!("there is no map to {what}"))
        }
    }

    /// The board a command named, or `None` when it named the staged slot and
    /// nothing is staged.
    ///
    /// The server-side counterpart of `shownBoard`, for the same reason: without
    /// one function answering "which of the two", every arm below grows an
    /// `if staged`, and the one that forgets writes the next dungeon's walls
    /// across the board the table is looking at.
    ///
    /// Separate accessors instead of one returning a struct, because the borrow
    /// checker cares which of them is mutable and each caller wants one.
    fn map_in(&self, staged: bool) -> Option<&MapInfo> {
        if staged {
            self.staged.as_ref().map(|s| &s.map)
        } else {
            Some(&self.map)
        }
    }

    fn walls_in(&self, staged: bool) -> &[Wall] {
        if staged {
            // Empty for an empty slot, which is what an untraced map looks like
            // anyway. A player's copy relies on the same thing.
            self.staged.as_ref().map_or(&[], |s| s.walls.as_slice())
        } else {
            &self.walls
        }
    }

    /// The mutable halves, which `apply` uses and `check` does not. `None` only
    /// ever means an empty staged slot, which `check` has already refused.
    fn walls_mut(&mut self, staged: bool) -> Option<&mut Vec<Wall>> {
        if staged {
            self.staged.as_mut().map(|s| &mut s.walls)
        } else {
            Some(&mut self.walls)
        }
    }

    fn overrides_mut(&mut self, staged: bool) -> Option<&mut HashMap<Cell, Override>> {
        if staged {
            self.staged.as_mut().map(|s| &mut s.overrides)
        } else {
            Some(&mut self.overrides)
        }
    }

    /// One board's overrides packed for the wire, which is what both
    /// `snapshot_for` and `message_for` hand the DM.
    fn overrides_for(&self, staged: bool) -> OverrideView {
        if staged {
            self.staged
                .as_ref()
                .map_or_else(OverrideView::default, |s| fog::pack_overrides(&s.overrides))
        } else {
            fog::pack_overrides(&self.overrides)
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
                    // The other side of the rule above: this token has no
                    // position on the board to move, only a plan for one. The
                    // client never offers it (a staged-only token is absent
                    // from the live board), so reaching here means a frame that
                    // would write a field the next promote overwrites.
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
                light_ft,
                markers,
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
                token_fields(name, img, *size, *hp, *light_ft, markers)?;
                finite(&[*x, *y])
            }

            ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                hp,
                light_ft,
                markers,
                ..
            } => {
                require_dm(client, "change a token")?;
                if !self.tokens.contains_key(id) {
                    return Err(format!("no such token: {}", id.0));
                }
                token_fields(name, img, *size, *hp, *light_ft, markers)
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
            // legitimate thing for the DM to ask for.
            ClientMsg::SetShowNames { .. } => require_dm(client, "label the board"),

            // Nothing to bound either: serde has already refused anything that
            // is not one of the two variants.
            ClientMsg::SetDiagonals { .. } => require_dm(client, "set how diagonals count"),
            ClientMsg::SetShowCursors { .. } => require_dm(client, "set what the boards draw"),

            // Nothing to bound here either. The switch above governs every
            // pointer in the room and this one governs the DM's; only the DM
            // decides either.
            ClientMsg::SetShowDmCursor { .. } => {
                require_dm(client, "set whose pointers the boards draw")
            }

            // Bounded by the rule `SetMap` bounds a URL with, and nothing else.
            // The picker only sends a path the pick route just handed back, so
            // this is a bound on a hostile frame, not on the panel.
            ClientMsg::SetBackdrop { url } => {
                require_dm(client, "put a picture in front of the table")?;
                if let Some(url) = url
                    && (url.is_empty() || url.len() > MAX_URL_LEN)
                {
                    return Err("that backdrop URL is not a usable length".to_owned());
                }
                Ok(())
            }

            // Bounded like `SetBackdrop`, for the same reason. Nothing here
            // checks *what* the file is: the library route already refused
            // anything that wasn't a track on the way in, and a URL this room
            // never served just plays nothing.
            ClientMsg::SetAudio { url } => {
                require_dm(client, "choose the music")?;
                if let Some(url) = url
                    && (url.is_empty() || url.len() > MAX_URL_LEN)
                {
                    return Err("that track URL is not a usable length".to_owned());
                }
                Ok(())
            }

            // Which slot this is for makes no difference here: a grid size or a
            // play area is no more or less usable for being staged, so both go
            // through one set of bounds instead of two that could drift.
            ClientMsg::SetMap {
                url,
                grid_px,
                offset_x,
                offset_y,
                grid_color,
                play_area,
                fog: _,
                vision_ft,
                // Nothing to bound: serde has already refused anything that is
                // not one of the two variants, and either is a legitimate thing
                // for the DM to ask for.
                lighting: _,
                // Unlike `lighting`, this one carries a number, so serde
                // refusing the variant is not the whole check.
                grid_shape,
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
                // A cell's width is `grid_px * ratio`, so the bound above only
                // holds for both axes once this one does. A zero or negative
                // ratio is the sharper case: it collapses the lattice, and
                // `fog::basis` would hand back two parallel axes that no point
                // in image pixels can be resolved against.
                if let GridShape::Iso { ratio } = grid_shape {
                    finite(&[*ratio])?;
                    if !(MIN_GRID_RATIO..=MAX_GRID_RATIO).contains(ratio) {
                        return Err(format!(
                            "an isometric cell must be between {MIN_GRID_RATIO} and {MAX_GRID_RATIO} times as wide as it is tall"
                        ));
                    }
                }
                // `fog` needs no check: a bool has no bad value, and either
                // state is a legitimate thing for the DM to ask for.
                //
                // The radius does. The sweep in `fog.rs` is quadratic in it, and
                // on a map with no play area to clip against, this bound is the
                // only thing that stops the loop being unbounded. That holds in
                // both lighting modes, since the room fill is bounded by the
                // radius as well as by the walls.
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
                    // Bounded, not just positive: the client rules one grid
                    // line per cell across this width, so an absurd size here
                    // freezes the browser.
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

            // Refused instead of doing nothing, the way deleting a token that
            // isn't there is refused: both mean the DM's panel and the room
            // disagree about what exists, and an error is how that gets
            // noticed.
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
            // per-shape, not per-role.
            ClientMsg::Sketch { at, to, color, .. } => {
                finite(&[at.x, at.y])?;
                shape_fields(*to, color)
            }

            // Anyone may say something; the only permission is *where it is
            // going*. There is no `require_dm` and no per-item rule. What a
            // player may not do is name another player, which `may_address`
            // decides by destination, not by who they are.
            ClientMsg::Say { to, text } => {
                let text = text.trim();
                if text.is_empty() {
                    return Err("there is nothing to say".to_owned());
                }
                if text.chars().count() > MAX_CHAT_LEN {
                    return Err(format!("that is longer than {MAX_CHAT_LEN} characters"));
                }
                match (&client.identity, to) {
                    // The DM saying something to themselves. Refused instead of
                    // delivered, for the reason a promote with nothing staged is
                    // refused: a client and the room disagree about what the
                    // controls are. A note to self is what the scratchpad is for.
                    //
                    // **`Roll` allows this case**, because a secret roll has
                    // nowhere else to go. See the arm below.
                    (Identity::Dm, ChatTo::Dm) => {
                        Err("you are the DM — shout, or whisper a player".to_owned())
                    }
                    _ => self.may_address(&client.identity, to),
                }
            }

            // The loaner die. Two bounds and a destination. The destination is
            // checked by `may_address`, as for `Say`, and this arm differs from
            // `Say` in one place.
            ClientMsg::Roll { sides, count, to } => {
                if !DICE_SIDES.contains(sides) {
                    return Err("that is not a die in the bag".to_owned());
                }
                if *count == 0 {
                    return Err("that is no dice at all".to_owned());
                }
                if *count > MAX_DICE {
                    return Err(format!("that is more than {MAX_DICE} dice"));
                }
                match (&client.identity, to) {
                    // Where this differs from `Say`: the DM rolling a monster's
                    // save wants the number and wants nobody else to have it,
                    // and no other destination in the protocol means that.
                    // `party_to`'s `Dm` arm already handles it: the DM matches
                    // both halves and gets one copy, and no player is party to
                    // a line addressed there.
                    (Identity::Dm, ChatTo::Dm) => Ok(()),
                    _ => self.may_address(&client.identity, to),
                }
            }

            // Anyone may write in their own box, with no permission beyond
            // that: no role, no destination, no owner to compare. The command
            // names no box, so the only one it can reach is the sender's, and
            // this arm doesn't have to check it. The only check is size.
            ClientMsg::SetNotes { text } => {
                if text.chars().count() > MAX_NOTES_LEN {
                    return Err(format!("a scratchpad holds {MAX_NOTES_LEN} characters"));
                }
                Ok(())
            }

            // Keyed by the socket like `SetNotes`, and checked against a closed
            // set, as a token's size is. Don't make it a colour string: the six
            // hues are chosen so they can't be mistaken for the token rings the
            // board draws in gold, blue, white, violet and teal, and free hex
            // would let a player make their own ring say something false about
            // a creature.
            //
            // The DM is refused outright. Their hue is outside the six because
            // theirs is the one ring at the table that isn't a player's. That's
            // a rule about the board, not a control, so it's kept here, where
            // it holds whatever a client sends.
            ClientMsg::SetColour { colour } => match &client.identity {
                Identity::Dm => Err("the DM's colour is the DM's".to_owned()),
                Identity::Player(_) => {
                    if *colour < PALETTE {
                        Ok(())
                    } else {
                        Err(format!("there are {PALETTE} colours to choose from"))
                    }
                }
            },

            // Anyone may ping, and there is nothing else to check. No bound, no
            // clip to the play area, no fog test: the position is written into
            // no state, so it can't corrupt a save file. `finite` is here
            // anyway, because a NaN would reach six clients and draw a ring
            // nowhere.
            ClientMsg::Ping { at } => finite(&[at.x, at.y]),

            // Like `Ping`: the position is written into no state, so `finite`
            // is the only check. There is no permission (anybody may have a
            // pointer) and **no check that the room's switch is on**. A client
            // that goes on sending into a room that switched cursors off wastes
            // only its own bandwidth, because `message_for` drops every one of
            // these. Refusing it here would turn the switch into a stream of
            // red banners on whichever tab was open when it was flipped.
            ClientMsg::MoveCursor { at } => finite(&[at.x, at.y]),

            ClientMsg::AddShape {
                from, to, color, ..
            } => {
                if self.shapes.len() >= MAX_SHAPES {
                    return Err(format!("this board already holds {MAX_SHAPES} drawings"));
                }
                match from {
                    Origin::Point(at) => finite(&[at.x, at.y])?,
                    Origin::Token(id) => {
                        // Refused for a token this client can't see, with the
                        // same words as for a missing one. Any other answer for
                        // a hidden token would make this an oracle: sweep the
                        // id space and the refusals map out the DM's monsters.
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
                // Filtered before it is found, so a shape this client isn't
                // sent doesn't exist as far as they are concerned: they can't
                // erase it, and the refusal is the same as for an id nobody
                // ever held.
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
            // people's drawings, not only the sender's.
            ClientMsg::ClearShapes => require_dm(client, "clear the board"),

            // Every wall command is DM-only, and unlike the drawings there is no
            // per-item permission underneath: the walls are all the DM's, so
            // "may this client touch a wall" and "is this client the DM" are the
            // same question.
            ClientMsg::AddWalls { points, staged, .. } => {
                require_dm(client, "trace walls")?;
                // Before any of the geometry: a run traced onto a slot holding
                // no map has nothing to be traced over. The same refusal
                // `CreateToken` and a staged `MoveToken` make; it's about the
                // slot being empty, not about preview.
                if *staged {
                    self.staged_slot("trace walls on")?;
                }
                // Two points make one segment. One is a click that started a run
                // and never finished it, which the client doesn't send, so
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
                // is what the room is being asked to grow by. Counted against
                // the board it's traced on: the cap is one map's worth of walls,
                // and the two slots each hold one map.
                if self.walls_in(*staged).len() + points.len() - 1 > MAX_WALLS {
                    return Err(format!("this map already holds {MAX_WALLS} wall segments"));
                }
                for point in points {
                    finite(&[point.x, point.y])?;
                    // Image pixels, so the same bound as the play area, for the
                    // same reason: this is geometry over the art. Negative is
                    // allowed: the map is drawn from the world origin, but a DM
                    // tracing right up to the edge shouldn't have a corner
                    // refused for landing a pixel outside it.
                    if point.x.abs() > MAX_MAP_PX || point.y.abs() > MAX_MAP_PX {
                        return Err("that wall is not on the map".to_owned());
                    }
                }
                Ok(())
            }

            // "Already gone", not "no such wall", as erasing a shape reads.
            // There's nothing to leak here (a player can't get this far), but
            // the DM's client can race itself with two tabs open, and a refusal
            // that describes the outcome is more use than one that describes the
            // lookup.
            //
            // Looked up only in the slot the command named. The ids are UUIDs,
            // so searching both would find it either way, and would then erase
            // a live segment on a frame the DM sent while looking at the staged
            // board. The `staged` flag exists to make that impossible.
            ClientMsg::RemoveWall { id, staged } => {
                require_dm(client, "erase walls")?;
                if self.walls_in(*staged).iter().any(|w| &w.id == id) {
                    Ok(())
                } else {
                    Err("that wall is already gone".to_owned())
                }
            }

            ClientMsg::ToggleDoor { id, staged } => {
                require_dm(client, "open and close doors")?;
                match self.walls_in(*staged).iter().find(|w| &w.id == id) {
                    Some(wall) if wall.door().is_some() => Ok(()),
                    // Refused, not ignored: a toggle that lands on a solid
                    // wall means the client and the room disagree about what
                    // that segment is, and doing nothing would hide it.
                    Some(_) => Err("that is a wall, not a door".to_owned()),
                    None => Err("that wall is already gone".to_owned()),
                }
            }

            ClientMsg::ClearWalls { staged } => {
                require_dm(client, "clear the walls")?;
                if *staged {
                    self.staged_slot("clear the walls of")?;
                }
                Ok(())
            }

            ClientMsg::SetFogOverride { cells, staged, .. } => {
                require_dm(client, "override the fog")?;
                if *staged {
                    self.staged_slot("paint")?;
                }
                // Refused, not stored and ignored. An override on a map with no
                // fog has no effect, and a command that does nothing without
                // saying so is worse than one that says why. The panel greys
                // itself for the same reason.
                //
                // Asked of the board the paint is for: a fogged staged map may
                // be painted while the unfogged live one may not, and the DM is
                // preparing the staged one.
                let Some(map) = self.map_in(*staged) else {
                    return Err("there is no map to paint".to_owned());
                };
                if !map.fog {
                    return Err("there is no fog on this map to override".to_owned());
                }
                if cells.is_empty() {
                    return Err("that is no cells at all".to_owned());
                }
                // A fill can legitimately be a whole dungeon, so the cap is
                // generous. It's here for the fill that escapes through a gap
                // the DM didn't notice and the client bug that sends a million
                // cells; either way, the frame is the cost.
                if cells.len() > MAX_OVERRIDE_CELLS {
                    return Err(format!(
                        "that is more than {MAX_OVERRIDE_CELLS} cells at once"
                    ));
                }
                // Clipped for the reason the sweep in `fog.rs` clips itself: a
                // cell a million squares out lands in the bounding box of the
                // packed rectangle, and a box spanning it and the dungeon is a
                // huge string on every send. Checked against the named board's
                // own play area, since the two slots hold different images,
                // usually of different sizes.
                if cells.iter().any(|&c| !fog::cell_on_board(map, c)) {
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
                // Refused like a token that doesn't exist, because on the board
                // it's a creature that isn't there. Combat is the fight
                // happening now, and building the next room's order in advance
                // needs rolls nobody has made.
                if named.staged_only {
                    return Err(format!("{} is not on the board yet", named.name));
                }
                Ok(())
            }

            ClientMsg::RemoveFromInitiative { .. }
            | ClientMsg::ClearInitiative
            | ClientMsg::NextTurn
            | ClientMsg::PreviousTurn => require_dm(client, "change initiative"),

            ClientMsg::Undo => {
                require_dm(client, "undo")?;
                // The DM's own button is inert with an empty ring, so reaching
                // here means their client and the room disagree about what is
                // on it (most likely a second DM tab that undid the same step
                // first). Refused, not ignored, for `ToggleDoor`'s reason:
                // doing nothing would hide the disagreement.
                if self.undo_label().is_none() {
                    return Err("there is nothing to undo".to_owned());
                }
                Ok(())
            }
        }
    }

    /// Step 3. Mutates state, returns what happened.
    ///
    /// `origin` is here for the drawing commands and nothing else. Every other
    /// command is checked against who sent it and then applied the same way
    /// whoever that was. A sketch belongs to the connection that swept it, and a
    /// kept shape records who drew it, so for these the *effect* depends on the
    /// sender, not only their permission to send it.
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
                    // `check` already proved this exists. The `else` is so a
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
                // This branch is all it takes to route a drag to the plan
                // instead of the board. Everything either side of it (the
                // throttle, the snap, the debounce) is unaware there are two
                // positions.
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
                light_ft,
                markers,
                staged,
            } => {
                // The id is made here, not accepted from the client, so nothing
                // a DM sends can collide with a token that exists.
                let id = TokenId(Uuid::new_v4().simple().to_string());
                let (x, y) = snap_to_cell(x, y, size);
                self.tokens.insert(
                    id.clone(),
                    Token {
                        id: id.clone(),
                        name: name.trim().to_owned(),
                        // A staged-only token's `x, y` is a placeholder its own
                        // plan overwrites on promote. It is set to the same cell
                        // instead of zero: nothing reads it, and if it were
                        // ever reached by mistake, the token would be found
                        // where it was built.
                        x,
                        y,
                        owner,
                        img,
                        size,
                        markers,
                        hidden,
                        hp,
                        light_ft,
                        staged_pos: staged.then_some(Pos { x, y }),
                        staged_only: staged,
                    },
                );
                // Nobody held this token a moment ago, the same as for one
                // created hidden or built on the next map, so there is nothing
                // to take away from the table.
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
                light_ft,
                markers,
            } => {
                // Read through `unseen_by_table`, which needs `&self`, so it has
                // to happen before the mutable borrow below. Don't ask
                // `Token::unseen` here: renaming a monster standing in the dark
                // would send the table a `TokenRemoved` for an id they have
                // never held.
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
                token.markers = markers;
                token.hidden = hidden;
                token.hp = hp;
                token.light_ft = light_ft;

                // Resizing changes which lattice the token belongs on (a 2×2
                // settles on a cell corner, a 1×1 on a centre), so growing one
                // where it stands would leave it straddling half a cell until
                // somebody dragged it.
                if token.size != size {
                    token.size = size;
                    let (x, y) = snap_to_cell(token.x, token.y, size);
                    token.x = x;
                    token.y = y;
                    // The plan is a position on the same lattice and is snapped
                    // the same way. Without this, a token resized after being
                    // planned straddles half a cell the moment it is promoted.
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
                // and unhiding puts it back, so the panel is rebuilt, as it is
                // when a token is deleted. Without this the players keep a row
                // naming a token their client has just been told to forget,
                // which draws as a bare id and gives away what `hidden` hides.
                //
                // Asked of `unseen`, not `hidden`, so that toggling the flag on
                // a staged-only token (which the table can't see either way)
                // rebuilds nothing.
                if was_unseen != now_unseen && self.initiative.index_of(&id).is_some() {
                    events.push(Event::InitiativeChanged);
                }
                // The same for what is drawn on it. An aura anchored to a
                // monster the DM has just hidden has to leave the table's board
                // with it, or the shape stays where the creature is standing,
                // which is what was being withheld.
                //
                // Gated on something being anchored to it, not only on the
                // flip: an unconditional rebuild would tell the table that
                // *something happened* every time the DM hid anything.
                if was_unseen != now_unseen && self.anchors_a_shape(&id) {
                    events.push(Event::ShapesChanged);
                }
                events
            }

            // Its plan goes with it, like any other field. There's nothing
            // extra to do because the plan lives on the token, not beside it.
            ClientMsg::DeleteToken { id } => self.delete_token(&id),

            // Emitted whether or not it changed anything, like `ClearWalls`: a
            // frame that repeats what the room already said is a no-op on
            // arrival, and a comparison here would be a second place the answer
            // is decided.
            ClientMsg::SetShowNames { show } => {
                self.show_names = show;
                vec![Event::NamesChanged]
            }

            // Unconditional for the same reason, and a second: a client that
            // missed a frame has no way to ask, so a redundant send is the
            // cheapest resync there is.
            ClientMsg::SetDiagonals { diagonals } => {
                self.diagonals = diagonals;
                vec![Event::DiagonalsChanged]
            }

            // Unconditional for both reasons above. The resync matters most
            // here: a client holding a stale `false` stops sending its own
            // pointer, and nothing on its screen says why.
            ClientMsg::SetShowCursors { show } => {
                self.show_cursors = show;
                vec![Event::CursorsChanged]
            }

            // Unconditional for both reasons above. A client does nothing with
            // this but set a checkbox, so a redundant frame costs nothing.
            ClientMsg::SetShowDmCursor { show } => {
                self.show_dm_cursor = show;
                vec![Event::DmCursorChanged]
            }

            // **This arm must stay this short.** Sweeping the shapes,
            // forgetting the fog and clearing the walls are what a DM might
            // expect when the board is covered, and are what this command
            // exists not to do. One assignment and one event: the board is
            // untouched, so taking the picture down puts the table back where
            // they were. See `docs/maps.md`.
            ClientMsg::SetBackdrop { url } => {
                self.backdrop = url;
                vec![Event::BackdropChanged]
            }

            // Short like `SetBackdrop`, for the same reason: nothing on the
            // board changes, so nothing is swept. The room holds a URL, not a
            // playback position. Where each browser is in the track is up to
            // that browser, and syncing positions is out of scope. See
            // `docs/sound.md`.
            ClientMsg::SetAudio { url } => {
                self.audio = url;
                vec![Event::AudioChanged]
            }

            // Tokens are untouched. They are stored in grid units, so
            // recalibrating changes where a token *draws* without changing
            // which cell it is in (invariant 1, and the reason positions are
            // not kept in pixels).
            ClientMsg::SetMap {
                url,
                grid_px,
                offset_x,
                offset_y,
                grid_color,
                play_area,
                fog,
                vision_ft,
                lighting,
                grid_shape,
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
                    lighting,
                    grid_shape,
                };

                // The URL alone says which of the two things this is. A URL the
                // slot is not already showing is a map being loaded, so anything
                // remembered for it wins over what the client sent. That is how
                // re-picking a map comes back calibrated without the client
                // knowing the table exists. A URL that matches what the slot
                // holds is the DM recalibrating it, which is applied as given.
                //
                // Record only in the second case, and on a load of a map with
                // nothing remembered yet. If a load recorded too, a remembered
                // calibration would immediately be overwritten with the
                // client's guess.
                //
                // An empty staged slot holds no URL, so filling it is always a
                // load. That makes a map come back calibrated the moment it is
                // staged, not only once it is promoted.
                let showing = if staged {
                    self.staged.as_ref().map(|board| &board.map.url)
                } else {
                    Some(&self.map.url)
                };
                let loading = showing != Some(&url);
                //
                // **A recalibration writes the calibration and nothing else.**
                // The entry also holds the walls and the paint prepared on this
                // image, and those aren't the client's to send. Inserting a
                // whole `Prepared` here would file empty walls over half an
                // hour of tracing every time the DM nudged the grid, and the
                // board would go on showing the old ones until the map was next
                // loaded away from. Assigning the one field rules that out.
                let calibration = match self.calibrations.get_mut(&url) {
                    Some(prepared) if loading => prepared.calibration.clone(),
                    Some(prepared) => {
                        prepared.calibration = given.clone();
                        given
                    }
                    None => {
                        self.calibrations.insert(
                            url.clone(),
                            Prepared {
                                calibration: given.clone(),
                                ..Prepared::default()
                            },
                        );
                        given
                    }
                };

                // One table, keyed by URL, for both slots. Calibrating a map
                // while it is staged is what makes it arrive on the board
                // already calibrated when it is promoted.
                let finished = calibration.into_map(url.clone());
                if staged {
                    // Staged token state belongs to the staged map and goes
                    // with it. The same `loading` as the calibration table tells
                    // the two cases apart: a *different* map is a different next
                    // room, so the monsters placed for the last one go. A
                    // recalibration must not sweep them away. Correcting the
                    // grid after placing an ambush is an ordinary thing to do,
                    // and this is the case that gets missed.
                    let mut events = if loading {
                        self.clear_staged_tokens()
                    } else {
                        Vec::new()
                    };

                    // The staged board's own geometry, swept by the same rule as
                    // the live board's in the `else` branch below. That is why
                    // the two slots hold the same three things. A *load* is a
                    // different image, and nothing traced on the last one means
                    // anything on it. A **recalibration keeps the walls and
                    // drops the paint**: a wall is in image pixels and still
                    // traces the same painted line, and an override is a cell
                    // whose square has just moved.
                    let reshaped = self.staged.as_ref().is_some_and(|board| {
                        (
                            board.map.grid_px,
                            board.map.offset_x,
                            board.map.offset_y,
                            board.map.play_area,
                        ) != (
                            finished.grid_px,
                            finished.offset_x,
                            finished.offset_y,
                            finished.play_area,
                        )
                    });
                    let previous = self.staged.take();
                    // **The second place the shelf is written, and the one that
                    // gets missed.** A staged board never passes through
                    // `sweep_board`; it is discarded here, when a load replaces
                    // whatever was in the slot. The rule is the live board's:
                    // what a board had traced on it is filed under *its* URL as
                    // it stops being held. The only difference is that the URL
                    // and the walls are local values here, not on `self`.
                    if loading && let Some(board) = &previous {
                        self.shelve(
                            &board.map.url,
                            board.walls.clone(),
                            fog::pack_overrides(&board.overrides),
                        );
                    }
                    let carried = match previous {
                        Some(board) if !loading => StagedBoard {
                            map: finished,
                            walls: board.walls,
                            overrides: if reshaped {
                                HashMap::new()
                            } else {
                                board.overrides
                            },
                        },
                        // A load, or the first map into an empty slot. Nothing is
                        // carried *across*, but whatever the DM last prepared on
                        // this image comes back off the shelf with it. That lets
                        // three dungeons be traced on a Tuesday and found still
                        // traced on Saturday.
                        _ => {
                            let (walls, overrides) = self.prepared(&url);
                            StagedBoard {
                                map: finished,
                                walls,
                                overrides,
                            }
                        }
                    };
                    self.staged = Some(carried);

                    // Still one event, because the slot is one bundle:
                    // `StagedChanged` carries the whole slot, so a load that
                    // swept its walls and a recalibration that dropped its paint
                    // are both described by the frame the DM was getting anyway.
                    // There is no staged `WallsChanged` to remember to emit
                    // beside it.
                    events.push(Event::StagedChanged);
                    events
                } else {
                    // Forgetting the fog turns on `loading` and also on a
                    // recalibration. The explored cells are in grid space, so
                    // the lattice moving under them is enough on its own. A DM
                    // who nudges the offset by half a cell hasn't changed which
                    // rooms the party has been in, but has changed which squares
                    // those rooms are made of, and there's no correct way to
                    // carry the old answer across. Redrawing the play area is
                    // the same change at board scale: what was explored outside
                    // the new edge is not somewhere the party can be.
                    //
                    // Asked of the board's shape alone: turning the vision
                    // radius up is not a reason for the party to forget the
                    // dungeon, and neither is the grid's colour or turning fog
                    // off and on again.
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

                    // Plans are not cleared here. A plan describes a cell on the
                    // staged map, which this command hasn't touched, so the
                    // plans are still about the map they were made on.
                    //
                    // The URL of the board being left, read before the
                    // assignment overwrites it. `sweep_board` files what was
                    // traced on it under this, and can't work the name out for
                    // itself (see the note on that function).
                    let outgoing = std::mem::replace(&mut self.map, finished).url;
                    let mut events = vec![Event::MapChanged];
                    // The drawings and the walls are the opposite case from the
                    // plans, and turn on `loading`: they describe this image, and
                    // a new one is a new dungeon where none of it means anything.
                    // A recalibration must leave them alone, as it leaves the
                    // plans alone. This is the case that gets missed.
                    //
                    // **The two branches must stay exclusive.** A load clears
                    // everything the `reshaped` branch below clears, but running
                    // that branch first would empty the overrides *before* the
                    // sweep files them, and the DM's painted fog would go on the
                    // shelf as nothing. What a board is remembered by has to be
                    // read while the board still holds it.
                    if loading {
                        // What the sweep is about to gate its own two events on.
                        // Read here because both events are turned into messages
                        // at *dispatch*, against whatever the board holds then,
                        // so a frame the sweep already pushed will carry the
                        // restored list and a second one would repeat it.
                        let swept = (!self.walls.is_empty(), !self.overrides.is_empty());
                        events.append(&mut self.sweep_board(&outgoing));

                        // The other half of the shelf: whatever the DM last
                        // traced and painted on the image that just arrived
                        // comes back with it. After the sweep, never before it,
                        // because the sweep clears these two.
                        let (walls, overrides) = self.prepared(&url);
                        self.walls = walls;
                        self.overrides = overrides;
                        if !self.walls.is_empty() && !swept.0 {
                            events.push(Event::WallsChanged { staged: false });
                        }
                        if !self.overrides.is_empty() && !swept.1 {
                            events.push(Event::OverridesChanged { staged: false });
                        }
                    } else if reshaped {
                        self.forget_fog();
                        // The DM's overrides go for the same reason: they are
                        // cells, and the squares they name have just moved. This
                        // one needs its own event. Nothing recomputes it, so the
                        // DM's panel would go on drawing a mask the room no
                        // longer holds.
                        //
                        // The shelf is not written here, because a
                        // recalibration is not the map leaving. What gets filed
                        // is whatever the board holds when it does leave, which
                        // after this is nothing, matching what the DM now sees
                        // on screen.
                        if !self.overrides.is_empty() {
                            self.overrides.clear();
                            events.push(Event::OverridesChanged { staged: false });
                        }
                    }
                    events
                }
            }

            // A token with no plan is untouched here, as on a recalibration,
            // and for a stronger reason: it is stored in cells, and there is no
            // sensible way to carry a cell across to an unrelated image. It
            // keeps its coordinates and the DM repositions it. A plan is how
            // the DM places it in advance, and this is where the plan applies.
            ClientMsg::PromoteStaged => {
                let Some(board) = self.staged.take() else {
                    return Vec::new(); // proved to exist by `check`
                };

                // Tokens first, so that by the time a client is told the slot
                // has emptied (which ends the DM's preview), every token already
                // holds the position it landed on. It also reads the fog before
                // the sweep below does, so this order must not change.
                let mut events = self.promote_staged_tokens();
                // A promote is a new map arriving on the board, so the drawings
                // go the way they go for any other load, and so does everywhere
                // the party had explored: this is a different dungeon and they
                // have not been in it.
                //
                // The walls and the paint: the sweep clears the board's, and
                // then the staged board's land in their place. That is why
                // `sweep_board` is called before the assignment, not after it.
                //
                // The URL passed in is the *outgoing* board's, which here is
                // still `self.map` because the assignment is on the line below.
                // Callers differ on that, which is why `sweep_board` can't read
                // it for itself.
                let outgoing = self.map.url.clone();
                events.append(&mut self.sweep_board(&outgoing));
                self.map = board.map;
                self.walls = board.walls;
                self.overrides = board.overrides;
                // Gated the way the sweep's own events are, but on what
                // *arrived*, not what left: otherwise an empty staged board
                // promoting onto an empty live one sends a `WallsChanged` saying
                // nothing happened. `sweep_board` may have emitted one already
                // for the clear, and a second frame naming the new list is the
                // right order: the DM ends up holding what is there.
                if !self.walls.is_empty() {
                    events.push(Event::WallsChanged { staged: false });
                }
                if !self.overrides.is_empty() {
                    events.push(Event::OverridesChanged { staged: false });
                }
                // Then two more, because two things happened: the board
                // changed for everyone, and the slot emptied for the DM.
                events.push(Event::MapChanged);
                events.push(Event::StagedChanged);
                events
            }

            ClientMsg::ClearStaged => {
                let mut events = self.clear_staged_tokens();
                // The staged slot's other exit. It files what it is throwing
                // away, as the load arm does: the shelf is keyed by image, not
                // by slot, so which of the two buttons the DM pressed must not
                // change what next week's load finds. Discarding the *prep* is
                // `ClearWalls`, which is a step on the undo ring; this discards
                // the slot.
                //
                // The plans are not filed and are lost, because they are on the
                // tokens, not on the map. See *Two omissions, and the second is
                // the boundary* in `docs/maps.md`.
                if let Some(board) = self.staged.take() {
                    self.shelve(
                        &board.map.url,
                        board.walls,
                        fog::pack_overrides(&board.overrides),
                    );
                }
                events.push(Event::StagedChanged);
                events
            }

            // Relayed and forgotten. The room doesn't hold the sweep at all:
            // the next frame replaces it and the release ends it. So a
            // measuring line costs the save file nothing, and a client joining
            // mid-sweep is sent no sketch, because `RoomView` can only describe
            // what the room knows.
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
                    // is the safe choice: the DM can erase any shape anyway.
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

            // The one arm in this function that appends to a list nothing else
            // in the room reads. `check` has already decided the destination is
            // one this client may name, so all that is left is to write down who
            // said it, from the socket and never from the frame.
            ClientMsg::Say { to, text } => {
                let by = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // `check` proved this is a client. This decides whose name
                    // goes on the line, so there is no fallback owner: an
                    // unattributable line is one nobody sent.
                    None => return Vec::new(),
                };
                self.log(ChatLine {
                    by,
                    to,
                    // Trimmed here as well as in `check`, because `check` only
                    // looked at a borrow. What goes in the log is what the room
                    // decided was sayable, not what arrived.
                    text: text.trim().to_owned(),
                    // Somebody typed this.
                    rolled: false,
                })
            }

            // The room throws the dice, and what comes out is an ordinary line
            // of talk. Everything after this point (who is party to it, the
            // cap, the frame, the badge on somebody's dock) is `Say`'s code,
            // reused unchanged.
            ClientMsg::Roll { sides, count, to } => {
                let by = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // `check` proved this is a client, as in `Say`: an
                    // unattributable roll is one nobody threw.
                    None => return Vec::new(),
                };
                let faces = roll(sides, count);
                self.log(ChatLine {
                    by,
                    to,
                    text: rolled_text(sides, &faces),
                    // The room threw this one. That is the only difference from
                    // `Say`, and all the flag means.
                    rolled: true,
                })
            }

            // Whose box this is comes from the socket, as a chat line's author
            // does. Written whole, not patched: it is one string that changes
            // when somebody stops typing.
            //
            // Emptying it removes the entry instead of storing an empty
            // string, as `Override`'s `Auto` is the absence of an entry. One
            // representation of "there is nothing here", so a cleared box costs
            // the save file nothing and a player who never opened this leaves
            // no trace in it.
            ClientMsg::SetNotes { text } => {
                let owner = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // `check` proved this is a client. As in `Say` and `Roll`,
                    // this decides whose box is being written, and a note nobody
                    // owns is one nobody can ever be sent.
                    None => return Vec::new(),
                };
                if text.is_empty() {
                    self.notes.remove(&owner);
                } else {
                    self.notes.insert(owner.clone(), text.clone());
                }
                vec![Event::NotesChanged {
                    by: origin,
                    owner,
                    text,
                }]
            }

            // `SetNotes` without the private half. Whose colour it is still
            // comes from the socket and never from the frame, but there is no
            // `by` on the event, because there is nobody to exclude: this is
            // one table everybody holds, so everybody is sent the same one.
            ClientMsg::SetColour { colour } => {
                let id = match self.clients.get(&origin) {
                    Some(Client {
                        identity: Identity::Player(id),
                        ..
                    }) => id.clone(),
                    // `check` proved this is a player. The DM is refused there,
                    // and an unidentified socket never reaches `apply` at all.
                    _ => return Vec::new(),
                };
                self.colours.insert(id, colour);
                vec![Event::ColoursChanged]
            }

            // Nothing is applied: a ping changes nothing about the room, so the
            // body only reads `self`. It still goes through the pipeline instead
            // of being short-circuited earlier, because the four steps are where
            // permission and delivery live, and a command with its own path
            // around them is how one of the two gets forgotten.
            ClientMsg::Ping { at } => {
                let owner = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // Proved to be a client by `check`. The same fallback as
                    // `AddShape`, and harmless here for a simpler reason: this
                    // decides a ring's colour, not who may erase it.
                    None => Owner::Dm,
                };
                vec![Event::Pinged {
                    by: origin,
                    owner,
                    at,
                }]
            }

            // Like `Ping`, this only reads `self`. The room is not touched:
            // no field is written, nothing is marked dirty, and the event is
            // all that happened.
            //
            // The fallback is not harmless the way `Ping`'s is: an owner
            // guessed as the DM here would be a pointer that the fog filter
            // then treats as the DM's. `check` has already proved this is a
            // client, so the arm returns nothing instead of inventing a sender.
            ClientMsg::MoveCursor { at } => match self.clients.get(&origin) {
                Some(client) => vec![Event::CursorMoved {
                    by: origin,
                    owner: drawn_by(client),
                    at,
                }],
                None => Vec::new(),
            },

            // One run in, one segment per gap between its corners out. The run
            // itself is not stored (it was how the DM drew, not what the map
            // holds), so one bad segment of a long trace can be erased without
            // redrawing the rest of it.
            ClientMsg::AddWalls {
                points,
                door,
                staged,
            } => {
                let kind = if door {
                    // Traced shut. A door the DM has to close after drawing it is
                    // a door they will forget to close, and a dungeon's doors are
                    // shut until somebody opens them. That holds on both boards:
                    // a staged door is traced shut too, and the DM can open it
                    // before the promote.
                    WallKind::Door(false)
                } else {
                    WallKind::Solid
                };
                let Some(walls) = self.walls_mut(staged) else {
                    return Vec::new(); // proved to exist by `check`
                };
                for pair in points.windows(2) {
                    let [from, to] = pair else { continue };
                    walls.push(Wall {
                        // The server makes the id, as for a shape or a token.
                        id: WallId(Uuid::new_v4().simple().to_string()),
                        from: *from,
                        to: *to,
                        kind,
                    });
                }
                vec![Event::WallsChanged { staged }]
            }

            ClientMsg::RemoveWall { id, staged } => {
                if let Some(walls) = self.walls_mut(staged) {
                    walls.retain(|w| w.id != id);
                }
                vec![Event::WallsChanged { staged }]
            }

            // On the live board this is the party opening a door mid-fight. On
            // the staged one it is preparation: whatever it is left as is what
            // promotes, which is how the DM prepares a room that is already ajar.
            ClientMsg::ToggleDoor { id, staged } => {
                for wall in self.walls_mut(staged).into_iter().flatten() {
                    if wall.id == id {
                        // Proved to be a door by `check`. A solid wall is left
                        // alone, not turned into a door.
                        if let WallKind::Door(open) = wall.kind {
                            wall.kind = WallKind::Door(!open);
                        }
                    }
                }
                vec![Event::WallsChanged { staged }]
            }

            ClientMsg::ClearWalls { staged } => {
                if let Some(walls) = self.walls_mut(staged) {
                    walls.clear();
                }
                vec![Event::WallsChanged { staged }]
            }

            ClientMsg::SetFogOverride {
                cells,
                state,
                staged,
            } => {
                let Some(overrides) = self.overrides_mut(staged) else {
                    return Vec::new(); // proved to exist by `check`
                };
                match state {
                    // `Auto` is the absence of an entry, not a fourth variant,
                    // so handing cells back to the rays is a removal. One
                    // representation of "not overridden" keeps `recompute_sight`
                    // from having a case that does nothing.
                    None => {
                        for cell in cells {
                            overrides.remove(&cell);
                        }
                    }
                    Some(state) => {
                        for cell in cells {
                            overrides.insert(cell, state);
                        }
                    }
                }
                // `refresh_fog` reports the fog moving, not this arm. It
                // compares against a reading taken before `apply`, so whatever
                // the mask did to the two sets is already in the difference.
                // If the DM painted `Dark` over cells nobody could see anyway,
                // there is correctly no `FogChanged` at all.
                //
                // Painting the staged board gives it nothing to report:
                // `moves_sight` says so, because no ray has ever been cast on a
                // map the table hasn't been shown.
                vec![Event::OverridesChanged { staged }]
            }

            // The whole map back to dark, and then whatever the party can see
            // from where they are standing. Like `sweep_board` without the
            // board: the same three sets and the same mask, minus the shapes and
            // the walls, because this is the fog starting over, not the map.
            ClientMsg::ResetFog => {
                self.forget_fog();
                self.overrides.clear();
                vec![Event::OverridesChanged { staged: false }]
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

            ClientMsg::Undo => {
                // Pop the state the DM is in, then adopt whatever is behind it.
                // `check` proved there is one. The `let else` is there instead
                // of an `expect`, so a ring emptied between the two would leave
                // the room untouched, not panic.
                self.undo.pop_back();
                let Some(back) = self.undo.back() else {
                    return Vec::new();
                };
                // Cloned, not popped: the state being restored *is* the new top
                // of the ring, because the back of it is always where the DM now
                // stands. Taking it off would make the next undo skip a step.
                let back = back.state.clone();
                // **The scratchpads and the player colours are left alone by a
                // restore.** The ring may only hold state the DM could have
                // written. Every scratchpad on that snapshot was written by
                // somebody else, and restoring one loses a paragraph its author
                // can't get back and was never told about. A colour is a
                // player's in the same way. `undid` keeps `SetNotes` and
                // `SetColour` from *being* steps; this is the other half,
                // because a note or colour written between two other commands
                // is on the snapshot regardless of what put it there. Both
                // halves are needed for each. See `docs/undo.md`.
                //
                // Taken and put back, not filtered out of the snapshot at push
                // time: what belongs here is whatever people have typed
                // *since*, which is what the room is holding right now.
                let notes = std::mem::take(&mut self.notes);
                let colours = std::mem::take(&mut self.colours);
                self.adopt(back);
                self.notes = notes;
                self.colours = colours;
                // `adopt` empties both derived sets, because a `Saved` holds the
                // party's memory and not their sight. Recomputed here instead of
                // through `moves_sight` and `refresh_fog`, because `Restored`
                // already describes the whole board including its fog, and the
                // difference those would report would repeat it.
                self.recompute_sight();
                vec![Event::Restored, Event::UndoChanged]
            }
        }
    }

    /// Everything about the fog that a command might change, read before it runs.
    fn sight_now(&self) -> Sight {
        Sight {
            fog: self.fog_for(),
            // Read off the record, not off the tokens: this has to be what the
            // table *holds*, and a drag frame has already moved the one token
            // that could disagree. See `RoomState::shown`.
            seen: self.shown.clone(),
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
    /// Three things can fall out of a party taking one step, and only the first
    /// is the fog itself:
    ///
    /// - the fog frame, if what is lit or explored is not what it was;
    /// - a token appearing or vanishing for the table, because the cells it
    ///   stands on just changed state. The player who walked into the room has
    ///   never held the ogre in it, so `was_unseen` is true and `message_for`
    ///   turns the same event into a whole token for them, and into a
    ///   `TokenRemoved` for the reverse. This reuses the `was_unseen` handling
    ///   that hiding a token already has;
    /// - the panels that name those tokens. A creature the table cannot see must
    ///   not be a row in their initiative list or an aura on their board, the
    ///   same two gates that hiding a monster goes through.
    ///
    /// Both of the last two are gated on something having changed, and this is
    /// required, not tidiness: an unconditional `ShapesChanged` on every step
    /// would tell the table that *something happened* every time anybody moved.
    fn refresh_fog(&mut self, before: Sight, already: &[Event]) -> Vec<Event> {
        self.recompute_sight();

        let mut events = Vec::new();
        if self.fog_for() != before.fog {
            events.push(Event::FogChanged);
        }

        // A token the command already produced an event for is skipped. Each
        // of those events carries its own `was_unseen`, read through the same
        // question this one asks, so the transition has been announced once
        // already and a second frame would only repeat it.
        //
        // `TokenMoved` is not in that list. Walking out of the light is *how* a
        // creature stops being visible, and the move frame for it has just been
        // dropped for the recipients who now need to be told it is gone.
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
                | Event::BackdropChanged
                | Event::AudioChanged
                | Event::InitiativeChanged
                | Event::MapChanged
                | Event::StagedChanged
                | Event::Sketching { .. }
                | Event::SketchEnded { .. }
                | Event::Pinged { .. }
                | Event::CursorMoved { .. }
                | Event::Said { .. }
                | Event::NotesChanged { .. }
                | Event::ShapesChanged
                | Event::WallsChanged { .. }
                | Event::FogChanged
                | Event::OverridesChanged { .. }
                // `Restored` and `UndoChanged` can't reach here: `moves_sight`
                // is false for `Undo`, so `refresh_fog` doesn't run on the
                // command that produces them. Listed instead of caught by a
                // wildcard, because this match is exhaustive so that a later
                // event naming a token can't be forgotten.
                | Event::Restored
                | Event::PresenceChanged
                | Event::ColoursChanged
                | Event::CursorsChanged
                | Event::DmCursorChanged
                | Event::UndoChanged => None,
            })
            .collect();

        // Sorted, like every other batch in this file: `HashMap` order varies
        // per process and decides the order of the frames six clients receive.
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
        // is visible when its token is. An unanchored one gates on `known`
        // instead, so the fog opening onto ground somebody drew a circle on
        // changes it with no token involved. This second reading catches that.
        // Still one gate and one event: an unconditional `ShapesChanged` on
        // every step would tell the table that *something happened* every time
        // anybody moved.
        shapes |= self
            .shapes
            .iter()
            .any(|s| before.shapes.contains(&s.id) != self.shape_seen(s));
        if shapes {
            events.push(Event::ShapesChanged);
        }
        events
    }

    /// Files what was traced and painted on one image under that image's URL.
    ///
    /// **The shelf's only write.** Four paths reach it (a load into the live
    /// slot and a promote, both through `sweep_board`, and the two ways a staged
    /// board leaves its slot) and they hand over different boards, which is why
    /// the walls and the paint are arguments, not read off `self`. The rule they
    /// share is that a board's preparation is filed whenever that board stops
    /// being held, so which path the DM triggered can't change what the shelf
    /// remembers.
    ///
    /// Files whatever the board holds, including nothing: a DM who cleared the
    /// walls and then loaded away has cleared them, and filing only non-empty
    /// lists would bring the old walls back.
    ///
    /// Nothing is filed about the blank map a fresh room starts on: `check`
    /// refuses an empty map URL, so that string names no map anyone could load
    /// back.
    ///
    /// The read is `prepared`, below, called only from the `SetMap` arm beside
    /// the calibration lookup.
    fn shelve(&mut self, url: &str, walls: Vec<Wall>, overrides: OverrideView) {
        if url.is_empty() {
            return;
        }
        let prepared = self.calibrations.entry(url.to_owned()).or_default();
        prepared.walls = walls;
        prepared.overrides = overrides;
    }

    /// What was last traced and painted on an image, ready to go back onto a
    /// board. Empty for a map nothing has ever been prepared on, which is what
    /// an untraced map looks like anyway.
    fn prepared(&self, url: &str) -> (Vec<Wall>, HashMap<Cell, Override>) {
        self.calibrations
            .get(url)
            .map_or_else(Default::default, |p| {
                (p.walls.clone(), fog::unpack_overrides(&p.overrides))
            })
    }

    /// Everything drawn or traced over the map image, thrown away because that
    /// image is being replaced.
    ///
    /// Shared by a load into the live slot and by a promote, which is a load. It
    /// is *not* reached by a recalibration: the drawings are cells on this board
    /// and the walls trace this art, and correcting the grid changes neither.
    ///
    /// A promote clears with this and then puts the staged board's walls and
    /// paint in their place. That stays in the caller: this function clears,
    /// and its caller decides whether anything arrives, which is what lets a
    /// map load and a promote share it.
    ///
    /// Both halves are gated on being non-empty. An unconditional
    /// `ShapesChanged` on every map load tells the table something happened to
    /// a board that had nothing on it (the same gate the initiative panel
    /// uses). `WallsChanged` reaches only the DM, who is the one doing this, so
    /// the gate there just keeps the frames accurate.
    ///
    /// **The outgoing map's URL is passed in, not read off `self.map`.** The two
    /// call sites order the map assignment opposite ways round (a `SetMap`
    /// assigns and then sweeps, a promote sweeps and then assigns), so
    /// `self.map.url` in here is the *incoming* map on one path and the
    /// outgoing one on the other. Filing a dungeon's walls under the name of
    /// the map that replaced it puts them back on the wrong image, and nothing
    /// looks wrong until the DM loads away and back.
    fn sweep_board(&mut self, outgoing: &str) -> Vec<Event> {
        // Onto the shelf before any of it is cleared, so the map keeps a copy
        // of what was on it and loading away doesn't lose half an hour of
        // tracing.
        self.shelve(
            outgoing,
            self.walls.clone(),
            fog::pack_overrides(&self.overrides),
        );
        let mut events = Vec::new();
        if !self.shapes.is_empty() {
            self.shapes.clear();
            events.push(Event::ShapesChanged);
        }
        // Cleared from the board like the drawings (the shelf above keeps the
        // copy). Walls are specific to the art, and a wall traced on the last
        // dungeon is a line across the middle of this one.
        if !self.walls.is_empty() {
            self.walls.clear();
            events.push(Event::WallsChanged { staged: false });
        }
        // The explored terrain goes too. A wall survives a recalibration
        // because it is in image pixels and still traces the same painted line;
        // these are cells, so the lattice moving underneath them is enough to
        // invalidate them, and a new image certainly is.
        //
        // No event of its own: `refresh_fog` runs after this on the way out of
        // `handle`, comparing against a reading taken before any of it, so the
        // clear is already in the difference it reports. Emitting one here
        // would send it twice.
        self.forget_fog();
        // The DM's overrides go with them, and this one *does* need its own
        // event: it is the DM's data, not a derived set, so nothing recomputes
        // it and the DM's own panel would go on drawing cells the room no longer
        // holds. Gated like the two above, for the same reason.
        if !self.overrides.is_empty() {
            self.overrides.clear();
            events.push(Event::OverridesChanged { staged: false });
        }
        events
    }

    /// Takes a token out of the room, and its initiative row with it.
    ///
    /// Shared by `DeleteToken` and by the sweep that throws away a staged map,
    /// which deletes the tokens that only existed on it. Otherwise the order
    /// would keep a row pointing at a token that no longer exists, which the
    /// panel renders as a bare id and `next_turn` would hand the turn to. A
    /// staged-only token can't be in the order, so that half does nothing on
    /// one of the two paths; one shared function is still better than two that
    /// could come to disagree about what deleting means.
    fn delete_token(&mut self, id: &TokenId) -> Vec<Event> {
        // Before the removal, and through `unseen_by_table`, not
        // `Token::unseen`: whether the table is told depends on whether they
        // could see it, and a monster standing in the dark is one they were
        // never told about. Once it is out of the room the question can't be
        // asked.
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
        // Anything anchored to it goes too, for the same reason as the
        // initiative row: a shape following a token that no longer exists has
        // no position to be drawn at.
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
    /// ever see again, and staged-only tokens that no board shows, since the
    /// live one doesn't draw them and the map they were built on is gone.
    /// Reached from `ClearStaged` and from a *load* into the staged slot.
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
        // `snapshot_for` sorts: two clients must not be sent one burst in two
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
        // `unseen_by_table`: a promote sweeps the board's fog, so by the time
        // the loop below runs the question would be asked of fog that has
        // already been cleared.
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
                    // chosen on, which is why the plan is one field and not a
                    // second copy of the token.
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
            //
            // Through `remove_client`, not a bare `clients.remove`. The socket
            // closing does raise `Disconnected`, but that arm is guarded on the
            // entry still being there, so a bare remove here would make the
            // guard false when the news arrived and every departure step would
            // be skipped without a trace.
            warn!(?client, "outbound mailbox full, dropping client");
            self.remove_client(client);
        }
    }

    /// The one way a client leaves, whether it hung up or wedged.
    ///
    /// Both `Disconnected` and `dispatch` must come through here. A bare
    /// `clients.remove` skips the departure steps: the presence strip keeps
    /// naming them, their roster slot stays taken on the picker, and a sketch
    /// in progress stays on every other screen.
    ///
    /// Re-entrant by way of `dispatch`, and bounded because every call removes at
    /// least one entry before dispatching: a client wedged by the frames sent
    /// here is removed by the nested call, not by a second visit to this one.
    fn remove_client(&mut self, client: ClientId) {
        self.pending.remove(&client);
        if self.clients.remove(&client).is_none() {
            return;
        }
        debug!(?client, remaining = self.clients.len(), "client left");
        // That slot just came free; anyone still on the picker should see it
        // immediately.
        self.refresh_pickers();
        // A client that vanishes mid-sweep sends no release, and its line would
        // sit on five other screens until somebody reloaded. Sent
        // unconditionally, because "was that client sketching" is state the
        // room would have to keep to answer, and an id nobody is drawing is a
        // no-op on arrival.
        //
        // A movement ruler can't do this: nothing tells the room a drag
        // stopped, so that one guesses with a timeout. Here the socket closing
        // *is* the news. The socket is already out of `clients`, so neither of
        // these reaches it and `here` no longer counts it.
        self.dispatch(
            client,
            &[Event::SketchEnded { by: client }, Event::PresenceChanged],
        );
    }

    /// The visibility filter. One `Event` in, at most one `ServerMsg` out, per
    /// recipient. Fog of war is enforced here, and is the reason `Event` and
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
                    // A plan is a cell on a map the table hasn't been shown, so
                    // the frame carrying one is for the DM alone, like
                    // `StagedChanged` but for one token instead of the whole
                    // board.
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

            // Read off `&self` per recipient, not carried on the event, so one
            // event can leave here as three different things. The DM gets the
            // token. A player gets a redacted copy if they may see it, the news
            // that it is gone if it has just been hidden, and nothing at all if
            // it was already hidden. That last case matters: a `TokenRemoved`
            // naming an id they never held would tell them a token exists,
            // which is what is being withheld.
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

            // Like `StagedChanged`, for one token: dropped for who the recipient
            // is, not for anything they did. A player's copy of this token is
            // the same either side of the change, so the only thing a frame
            // could tell them is that the DM just discarded a plan, which they
            // shouldn't learn.
            Event::TokenPlanChanged { id } => {
                let token = self.tokens.get(id)?;
                self.is_dm(recipient).then(|| ServerMsg::TokenChanged {
                    token: token.view_for(true),
                })
            }

            // All three cases at once. The DM needs a whole token: their client
            // holds `staged_pos` and `staged_only`, which have just been
            // emptied, and no `TokenMoved` could tell them so. A player meeting
            // the token for the first time needs a whole one too, because they
            // have never held it. A player who has been watching it all along
            // needs only where it went, and one that hasn't moved needs nothing.
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
                // Still out of the table's reach: the DM also took this one off
                // the board, or its plan landed it somewhere they have no line
                // of sight on. The second case is why this isn't simply `None`.
                // A token they were watching a moment ago has to be taken off
                // their board, not left standing at its old cell on a map that
                // is no longer there.
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

            // Built per recipient, not carried on the event, so the table's
            // panel can be a shorter list than the DM's.
            Event::InitiativeChanged => Some(ServerMsg::InitiativeChanged {
                initiative: self.initiative_for(self.is_dm(recipient)),
            }),

            // Echoed to the DM who sent it as well. Unlike a token drag there is
            // no local prediction to rubber-band: the client draws the grid the
            // server confirmed, so this frame is how the DM sees the result.
            Event::MapChanged => Some(ServerMsg::MapChanged {
                map: self.map.clone(),
            }),

            // Everyone, unfiltered, and echoed to the DM for the same reason:
            // their checkbox settles on this frame, not on their click. The DM
            // decides it and the table is told, as with `FogChanged`: the switch
            // is the DM's, the labelling is the board's.
            Event::NamesChanged => Some(ServerMsg::NamesChanged {
                show: self.show_names,
            }),

            // The same. The server never counts a diagonal, so all it is
            // authoritative over here is that everybody counts them the same
            // way.
            Event::DiagonalsChanged => Some(ServerMsg::DiagonalsChanged {
                diagonals: self.diagonals,
            }),

            // The same, and this frame changes what the recipient *sends*, not
            // only what it draws, so nobody may be left out of it: a client
            // still holding `true` after the switch went off would go on sending
            // its pointer into a room that drops every frame.
            Event::CursorsChanged => Some(ServerMsg::CursorsChanged {
                show: self.show_cursors,
            }),

            // The same. `CursorsChanged` is read in this filter; this one is
            // read in `cursor_seen` instead, which makes no difference to what
            // a client is sent here.
            Event::DmCursorChanged => Some(ServerMsg::DmCursorChanged {
                show: self.show_dm_cursor,
            }),

            // Unfiltered like the settings above. No other event goes with it:
            // covering the board changes no map, no wall, no shape and no cell
            // of fog, so this frame travels alone and every recipient still
            // holds the board it had.
            Event::BackdropChanged => Some(ServerMsg::BackdropChanged {
                url: self.backdrop.clone(),
            }),

            // Unfiltered, and alone for the same reason as `BackdropChanged`:
            // the music changes no map, no wall, no shape and no cell of fog.
            Event::AudioChanged => Some(ServerMsg::AudioChanged {
                url: self.audio.clone(),
            }),

            // Dropped for who the recipient is, not for anything they did. A
            // player is not sent a staged map and told not to draw it: the
            // frame doesn't exist for them at all.
            //
            // It carries the whole staged board, not only its map, so a staged
            // load sweeping its walls and a staged recalibration dropping its
            // paint need no frames of their own.
            Event::StagedChanged => self.is_dm(recipient).then(|| ServerMsg::StagedChanged {
                board: self.staged.as_ref().map(StagedBoard::view),
            }),

            // Keyed on `by`, not `origin`. They are the same client for a live
            // sweep but not on a disconnect: the frame that ends a stranded
            // sketch is dispatched with the departed client as both, and it is
            // the recipients who are still here that matter.
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

            // The pinger is skipped, as for a sketch: they are drawing their own
            // ring already. Past that echo, **nothing here filters a ping**.
            // There is no `is_dm`, no `unseen_by_table`, no `in_sight`, and that
            // is a decision, not an omission: a ping is relayed wherever it
            // lands, including onto ground the party has never explored.
            //
            // It is safe because there is nothing in it to read. A ring over
            // black says the DM is gesturing in a direction, not what is
            // standing there, and the DM can see their own fog while they hold
            // the button, so they know what they are pointing over. The
            // alternative is a 400ms gesture that sometimes does nothing with no
            // sign it failed, and a gesture you can't tell has failed is one you
            // stop trusting. See `docs/drawings.md`.
            Event::Pinged { by, owner, at } => (recipient != *by).then(|| ServerMsg::Pinged {
                by: owner.clone(),
                at: *at,
            }),

            // Unlike `Pinged`, this one is filtered by the fog. Read the two
            // together. A ping is a chosen 400ms gesture, and a ring over black
            // says only that somebody is pointing in a direction; a cursor is
            // nobody's decision, and the DM's drifts wherever the DM is working.
            // So this one asks `cursor_seen`, which is no filter at all for
            // three of its four cases and the fog for the fourth.
            //
            // The room's switch is read here, not in `check`, so it controls the
            // traffic and not only the display: with it off, not one of these
            // leaves the room. The mover is skipped for `Pinged`'s reason. Their
            // own pointer is drawn by their own operating system, and drawing a
            // second one a round trip behind it is the rubber-banding a token
            // drag already avoids.
            Event::CursorMoved { by, owner, at } => (recipient != *by
                && self.show_cursors
                && self.cursor_seen(owner, *at, self.is_dm(recipient)))
            .then(|| ServerMsg::CursorMoved {
                by: owner.clone(),
                at: *at,
            }),

            // Withheld from one player and sent to another. The filtered
            // arms above draw their line between the DM and the table; this one
            // draws it between two people at the same table, and the question
            // it asks is not `is_dm` at all. See `docs/chat.md`.
            //
            // The sender is sent their own, which no other relayed frame here
            // does (see `ServerMsg::Said`). Nothing about a line of text is
            // predicted on the client, because where it lands in the log is the
            // room's to decide.
            Event::Said { line } => {
                let identity = &self.clients.get(&recipient)?.identity;
                party_to(identity, line).then(|| ServerMsg::Said { line: line.clone() })
            }

            // **The DM is not automatically in this audience.** One person is
            // party to a scratchpad (its author), so this asks whose it is and
            // stops. An `is_dm` check here, as the filters above have, would
            // break it.
            //
            // Minus the socket that typed it, as with `Pinged` and unlike
            // `Said`: the text is already in that box, and writing it back a
            // round trip later moves the caret mid-sentence. So the author's
            // *second tab* is the only recipient this event ever has.
            Event::NotesChanged { by, owner, text } => {
                let identity = &self.clients.get(&recipient)?.identity;
                (recipient != *by && is_owner(identity, owner))
                    .then(|| ServerMsg::NotesChanged { text: text.clone() })
            }

            // Built per recipient, like the initiative panel and for the same
            // reason: the DM's board and the table's differ, and this is where
            // an aura on a hidden monster is dropped.
            Event::ShapesChanged => Some(ServerMsg::ShapesChanged {
                shapes: self.shapes_for(self.is_dm(recipient)),
            }),

            // DM-only, like `StagedChanged`: there is no filtered version of a
            // wall for a player to receive. Not an empty list either. A frame
            // carrying nothing still says the DM just did something, and with
            // fog on it would say *when* a door opened, on a board they can't
            // see through.
            //
            // Staging needs nothing extra here: there is no filtered form to
            // widen, so a staged wall is withheld by the same line as a live
            // one.
            Event::WallsChanged { staged } => {
                self.is_dm(recipient).then(|| ServerMsg::WallsChanged {
                    walls: self.walls_in(*staged).to_vec(),
                    staged: *staged,
                })
            }

            // The same for everybody. Fog is party-shared, so there is one
            // answer and no filtering left to do. The table gets this frame
            // instead of the walls above.
            Event::FogChanged => Some(ServerMsg::FogChanged {
                fog: self.fog_for(),
            }),

            // DM-only, like the walls. With `FogChanged` above, this is the
            // rule: what the DM decided reaches the DM, and the difference it
            // made reaches the table.
            Event::OverridesChanged { staged } => {
                self.is_dm(recipient).then(|| ServerMsg::OverridesChanged {
                    overrides: self.overrides_for(*staged),
                    staged: *staged,
                })
            }

            // **Everyone, and through `snapshot_for`** (invariant 3). Filtering
            // every delta correctly and then sending an unfiltered snapshot is
            // the most common way this project could leak, and an undo is a
            // snapshot. Routing it through the function a join uses means there
            // is no second filter to keep in step.
            //
            // A player is sent one too, and has to be: the room they are looking
            // at just changed underneath them. The DM's walls and staged map are
            // withheld from it as on any join.
            Event::Restored => {
                let identity = self.clients.get(&recipient)?.identity.clone();
                Some(ServerMsg::Restored {
                    state: Box::new(self.snapshot_for(&identity)),
                })
            }

            // DM-only, like the walls, though what is withheld here is not a
            // secret, only a label for a button a player doesn't have.
            Event::UndoChanged => self.is_dm(recipient).then(|| ServerMsg::UndoChanged {
                label: self.undo_label(),
            }),

            // Unfiltered, like `NamesChanged` and `FogChanged`: one list, read
            // off `&self`, identical for every recipient including whoever
            // caused it. There is nothing here to filter. Presence exists so the
            // table can tell whether the DM is still connected, and a colour
            // nobody else can see is no use.
            Event::PresenceChanged => Some(ServerMsg::Presence { here: self.here() }),
            Event::ColoursChanged => Some(ServerMsg::ColoursChanged {
                colours: self.colours.clone(),
            }),
        }
    }

    /// Reaches identified and pending connections alike: a client that has not
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
/// middle cell and settles on that cell's centre: a 1×1 in cell (0,0) is at
/// (0.5, 0.5). An even width has no middle cell and settles on the corner four
/// cells meet at, so a 2×2 covering cells (0,0) to (1,1) is at (1.0, 1.0).
/// Either way its edges land on grid lines.
///
/// Anything smaller than a cell settles like a single-cell token, not on a
/// lattice of its own: a druid who is currently a rat belongs in the middle of
/// a square, next to the party, not tucked into one quarter of one.
///
/// This rule lives only here. The client never snaps; it learns the settled
/// position from the echoed drop frame.
fn snap_to_cell(x: f32, y: f32, size: f32) -> (f32, f32) {
    let cells = size.max(1.0) as u32;
    let centre = if cells.is_multiple_of(2) { 0.0 } else { 0.5 };
    // Not `floor`: the lattice moves with `centre`, and rounding to the nearest
    // point on it works the same for both cases. `round` also does the right
    // thing below zero, where a token dragged off the top-left of the map must
    // land in cell -1, not fold back onto the board.
    ((x - centre).round() + centre, (y - centre).round() + centre)
}

#[cfg(test)]
mod tests;

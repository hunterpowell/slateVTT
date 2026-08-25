//! The room actor.
//!
//! One `tokio` task exclusively owns `RoomState`. Nothing else can reach it, so
//! there are no locks on it and no `Arc<Mutex<_>>`. Commands arrive on one
//! `mpsc`; each client gets its own `mpsc` back — never a `broadcast`, because
//! `broadcast` hands every subscriber the same value and fog of war will need
//! different clients to receive different messages for one event.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until};
use tracing::{debug, error, warn};
use uuid::Uuid;

use crate::fog::{self, Cell, FogView, Override, OverrideView};
use crate::protocol::{
    Calibration, ChatLine, ChatTo, ClientId, ClientMsg, Colours, Diagonals, Hp, Initiative,
    InitiativeEntry, MapInfo, Origin, Owner, PALETTE, PlayerId, Pos, Prepared, RoomView,
    RosterEntry, RosterSlot, ServerMsg, Shape, ShapeId, ShapeKind, StagedView, Token, TokenId,
    TokenView, Wall, WallId, WallKind,
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

/// How many undos the DM can take. The ring holds one more than this — the
/// state they are in now, plus this many to go back to.
///
/// Ten because a snapshot is the whole persisted room and this is memory rather
/// than disk, and because undo is for the mistake you just noticed rather than
/// for the one you made before dinner. One step per command means a long wall
/// trace fills it, which is deliberate and not a defect to design around: the
/// way out of a bad trace is `ClearWalls`, which is itself one undoable step.
const MAX_UNDO: usize = 10;

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
/// hundred, the whole traced level is a few thousand, and a 4000×3000 map at
/// 50 px to the cell is 80×60 — so this is generous on purpose. What it bounds
/// is the fill that escapes through a gap the DM did not notice and the client
/// that sends a million cells for any other reason: the frame is the cost, and
/// the refusal names the size so the DM knows to fill a smaller region rather
/// than wondering what went wrong.
///
/// **That refusal is only deliverable because this number is reconciled against
/// `MAX_WS_MESSAGE_BYTES`.** `cells` is a `Vec<Cell>` and a `Cell` is a tuple,
/// so the command carries `[x,y]` per cell — up to 12 bytes with the comma at
/// four-digit coordinates. 8,000 of them is ~94 KiB inside a 128 KiB frame.
/// It shipped at 50,000 against a 16 KiB frame, which is 25× over: the socket
/// died on the read and the DM's page reloaded, so the check below never ran.
/// `fog_of_war::largest_override_fits_in_a_frame` is what keeps the two honest,
/// and `MAX_FILL_CELLS` in `fogtool.ts` mirrors it — see `docs/net.md`.
const MAX_OVERRIDE_CELLS: usize = 8_000;

/// How much of a session's talk the room keeps.
///
/// A cap and not a policy: the log is trimmed from the front so a browser
/// hiccup mid-combat does not eat the initiative rolls somebody posted a minute
/// ago. It is memory only — nothing here reaches the disk — so this bounds a
/// `VecDeque` rather than a file, and 200 lines is an evening of six people
/// calling out numbers.
const MAX_CHAT_LINES: usize = 200;
/// How long one thing somebody says may be. A sentence, generously — this is a
/// table talking, not a journal, and the box is one line high on purpose.
const MAX_CHAT_LEN: usize = 400;

/// How much one person may keep in their scratchpad.
///
/// Four pages, which is far past what a box for "the innkeeper is called Doran"
/// is for and far short of anything that troubles a save file on a Raspberry Pi.
/// The client's textarea carries the same number as its `maxlength`, so typing
/// simply stops rather than bouncing off the room — this is the backstop for a
/// client that does not, which is the shape every cap on this file has.
const MAX_NOTES_LEN: usize = 10_000;

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

/// The cast of the Halloween one-shot.
///
/// A separate array rather than a second column on the one above, because the
/// two casts are independent — a different length, and no slug in common unless
/// one is written twice on purpose. A player who plays in both rooms holds two
/// slugs, which is what makes their tokens, their colour and their scratchpad
/// separate in each.
const HALLOWEEN_ROSTER: [(&str, &str); 6] = [
    ("player-1", "Player 1"),
    ("player-2", "Player 2"),
    ("player-3", "Player 3"),
    ("player-4", "Player 4"),
    ("player-5", "Player 5"),
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
/// **The id is the load-bearing field.** It names the save file on disk, the
/// `localStorage` key a player's claimed slot is remembered under, and the
/// `?room=` a link carries — so changing one after a room has been played in
/// orphans all three at once. It is a slug for the reason a roster id is, and
/// there is a test below that says so, because a room id with a slash in it
/// would be a path.
struct RoomDef {
    id: &'static str,
    /// What the room picker shows. Free text, and the only field here nothing
    /// is keyed on — renaming a campaign is safe at any point.
    name: &'static str,
    /// A slice rather than a fixed array, so two casts may differ in size.
    roster: &'static [(&'static str, &'static str)],
}

/// Every room, fixed at boot.
///
/// **A const rather than a registry**, which is the whole shape of this feature:
/// the rooms are known before the first socket opens, so `AppState` holds a map
/// that is built once and only ever read. `ROADMAP.md` budgeted an
/// `RwLock<HashMap<..>>` here; a lock guards a table that changes, and nothing
/// changes this one. Adding a campaign is an edit to this array and a redeploy,
/// which is the same act as editing a roster.
///
/// **The first entry is the primary room.** Two things follow from that and
/// nothing else does: it is the one whose save file is `SLATE_STATE` verbatim
/// rather than a sibling named after its id, and it is the one a fresh checkout
/// boots into `RoomState::hardcoded` rather than an empty board. Both are
/// answers to "which room did the single-room server become", so neither
/// generalises to a third room and neither should.
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
    /// Pointers are drawn on every board now, or they are not. The third of
    /// these, and identical to its two neighbours in every respect — including
    /// that the frame reaches the DM who flipped it.
    CursorsChanged,
    /// There is a picture in front of the table now, or there is not. The fourth
    /// of these and identical to the three above in every respect, including
    /// that the frame reaches the DM who put it up.
    BackdropChanged,
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
    /// Somebody pinged a spot on the board.
    ///
    /// The least stateful event in this enum, which is saying something with the
    /// two sketch arms directly above it. A sketch at least has a lifetime the
    /// room participates in — a `Sketching` is replaced by the next one and
    /// closed by a `SketchEnded`, and a socket dying has to close it too. This
    /// is one frame that lands, is relayed, and is over; nothing in the room
    /// knows a ping happened a moment later, and nothing has to.
    ///
    /// It carries both `by` and `owner` because they answer different questions
    /// and only one of them survives to the wire: `by` is the connection, which
    /// is what the filter compares against to keep the pinger from being echoed
    /// their own ring, and `owner` is the identity, which is what the recipients
    /// draw. Resolved here rather than in `message_for` because the filter runs
    /// per recipient and this is one lookup for all six.
    Pinged { by: ClientId, owner: Owner, at: Pos },
    /// Somebody's pointer moved.
    ///
    /// The event above with its `by` and `owner` meaning exactly the same two
    /// things, and one difference: **`message_for` has a question to ask about
    /// this one.** A ping is relayed wherever it lands; the DM's pointer over
    /// unexplored ground is not, because a hand that lingers is a hand that is
    /// working on something. `at` is carried for that filter to read as well as
    /// for the recipient to draw, which is why it is here rather than resolved
    /// per recipient — the answer differs by who is asking.
    ///
    /// Even less stateful than `Pinged`, which is a low bar it clears anyway: a
    /// ring at least stays on the recipient's screen on its own timer, while
    /// this is superseded by the next frame and forgotten by stillness. Nothing
    /// in the room knows a pointer was ever anywhere.
    CursorMoved { by: ClientId, owner: Owner, at: Pos },
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
    ///
    /// **Not payload-free about *which* board**, which is the one thing it must
    /// carry: the message rebuilt from it is a whole list, and the DM holds two.
    /// Reading the slot off `&self` at filter time instead would answer with
    /// whichever board the room is holding by then, and a promote in between
    /// makes that the wrong one.
    WallsChanged { staged: bool },
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
    /// It is never the whole of the news on the live board. Painting a cell there
    /// also moves the fog, so `refresh_fog` produces a `FogChanged` beside this
    /// one whenever anything the table can see actually changed. **Painting the
    /// staged board it is the whole of it**, and correctly so: there is no fog on
    /// a map the table has not been shown, so nothing casts a shadow yet.
    ///
    /// Carries its slot for the reason `WallsChanged` does.
    OverridesChanged { staged: bool },

    /// Somebody said something, and the room has already written it down.
    ///
    /// Carries the whole line, like `Sketching` and `Pinged` and unlike the
    /// payload-free events above — the text is the same for everyone allowed to
    /// have it, so there is nothing here to rebuild per recipient. What
    /// `message_for` does with it is decide *whether*, which is the walls' rule
    /// arriving somewhere new: a whisper is withheld from one player and sent to
    /// another, rather than withheld from every player.
    ///
    /// Unlike its two ephemeral neighbours the room does keep this — in memory,
    /// capped, and out of `Saved`, which is what keeps it off the disk and out
    /// of the undo ring without either of those having to name it.
    Said { line: ChatLine },

    /// Somebody's scratchpad changed, and it is theirs.
    ///
    /// **The first event in this enum that goes to one person who is not
    /// necessarily the DM**, and the first whose audience is narrower for the DM
    /// than for anyone else: their own box is the only one they are ever told
    /// about. `message_for` asks whose it is and nothing else — no `is_dm`, no
    /// board, no fog.
    ///
    /// Carries `by` as well as `owner` for `Pinged`'s reason: the socket that
    /// typed it already holds the text, and writing it back a round trip later
    /// would move the caret out from under whoever is still typing. What is left
    /// after that exclusion is the author's *other* tab, which is the whole
    /// reason this is an event rather than nothing at all.
    NotesChanged {
        by: ClientId,
        owner: Owner,
        text: String,
    },

    /// The DM undid something, and the room is now a state it held earlier.
    ///
    /// **The only event that describes the whole room rather than a part of
    /// it**, and the one place this project gives up on deltas — deliberately,
    /// because the case that makes undo worth having is `sweep_board`, where one
    /// map load destroys the walls, the shapes and the fog together. Writing the
    /// inverse of that is most of a second state model; re-sending everything is
    /// a function that already exists.
    ///
    /// Payload-free like its neighbours, and rebuilt per recipient through
    /// `snapshot_for` — so a restore is filtered by the same code a join is.
    /// That is invariant 3 arriving somewhere new: the most common way to leak
    /// is to filter every delta correctly and then hand over the whole world,
    /// and this is the second message that hands over the whole world.
    Restored,
    /// What the DM's undo would take back has changed.
    ///
    /// Reaches the DM or nobody, like `WallsChanged` and `OverridesChanged`, and
    /// it is the first of those three where the reason is not that a player must
    /// not know: it is that a player has no undo button for this to label.
    ///
    /// Payload-free for the reason the rest are — `message_for` reads the ring
    /// off `&self`. It rides beside every step added and every step taken back,
    /// which is the `OverridesChanged` / `FogChanged` pairing again: the room
    /// changed, and so did what the DM can say about it next.
    UndoChanged,

    /// Somebody joined or left.
    ///
    /// **The only event in this enum no command produced.** Every other variant
    /// here is the tail of a `ClientMsg` that arrived and was allowed; this one
    /// is dispatched from the two places the socket table changes — a `Hello`
    /// that turned into an identity, and a connection that went away. That is
    /// also why it is the only one `persists` refuses on a principle rather than
    /// on it being ephemeral: who happens to be connected is not part of the
    /// room.
    ///
    /// Payload-free like its neighbours; `message_for` reads the list off
    /// `&self`, and every recipient gets the same one.
    PresenceChanged,
    /// A player picked their colour.
    ///
    /// Payload-free for the reason above and identical for every recipient, the
    /// sender included — there is nothing to exclude them from, because nothing
    /// was drawn locally and there is no caret for an echo to move. That is what
    /// separates it from `NotesChanged`, which is the other thing on this list
    /// that a player writes.
    ColoursChanged,
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

/// The staged slot as the room holds it: the map the DM is preparing, and the
/// walls and overrides they have prepared on it.
///
/// `StagedView`'s twin, and the split is the one this project makes three times
/// already — that type is what crosses the wire and goes to disk, this is what
/// the room computes with. The difference is one field: the overrides are a
/// packed rectangle out there and a map of cells in here, exactly as the live
/// board's are.
///
/// A bundle rather than three fields beside `staged`, because the three arrive,
/// sweep and promote as one thing. The live board's stay flat on `RoomState`
/// below, and that asymmetry is honest rather than an unfinished refactor: the
/// live board is the room, and this is a parcel waiting to be delivered into it.
#[derive(Debug, Clone, Default)]
struct StagedBoard {
    map: MapInfo,
    /// Traced over the staged image before the table has ever seen it, which is
    /// the whole of milestone 20. **They add no visibility surface at all**: a
    /// wall reaches the DM or nobody, so there was no filter here to widen —
    /// unlike `staged_only`, which had to grow `unseen_by_table` a third reason.
    walls: Vec<Wall>,
    /// Painted over the staged board by hand, and promoted with it.
    ///
    /// There is deliberately no staged `revealed`, `known` or `visible` to sit
    /// under these. A staged override is not a preview of what the party will
    /// see — it is what the DM is handing them the moment the map lands. See
    /// *No staged fog* in `docs/fog.md`.
    overrides: HashMap<Cell, Override>,
}

impl StagedBoard {
    /// The wire and disk form of this slot. One function, because what the DM
    /// may hold of the staged board and what the file must hold of it are the
    /// same thing — a player holds none of it either way, so there is nothing
    /// here for a `view_for` to redact and no second caller to disagree.
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
    /// The map the DM is preparing for later, which the table cannot see, and
    /// everything they have prepared on it. It is stripped in `snapshot_for` and
    /// filtered out in `message_for` — and because the three are one bundle,
    /// that is still one `None` rather than three fields each able to be
    /// forgotten.
    staged: Option<StagedBoard>,
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
    /// traced in. **These are the live board's**; the staged board has its own
    /// list on `StagedBoard`, and a promote is what carries one into the other.
    /// That is still one slot rather than the scene concept CLAUDE.md rules out.
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
    /// Which tokens the table has been shown, as of the last recompute.
    ///
    /// Derived and never persisted like the two sets above — and **recorded when
    /// the recompute runs**, rather than read back off the room when the next
    /// command arrives, which is the one thing that cannot work. A drag frame
    /// moves a token in memory without a recompute, so by the time the drop asks
    /// what the table could see a moment ago, the creature has already been
    /// carried into the dark and the honest answer off `&self` is "they never saw
    /// it" — which is how a monster ends up standing on their board forever at
    /// the last cell a frame reached them. See `docs/fog.md`.
    shown: HashSet<TokenId>,
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
    /// are cells, so a new lattice invalidates them. **The live board's**; the
    /// staged board paints into its own map on `StagedBoard`, and a promote is
    /// what replaces these with those.
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
    /// Whether everybody's pointer is drawn on everybody's board.
    ///
    /// The third room-wide switch and the two above it in every respect: the
    /// DM's to set, everyone's to hold, filtered by nobody. What is different is
    /// that this one is read *in the filter* — `CursorMoved` is dropped for
    /// every recipient while it is off, so the frames stop crossing the wire
    /// rather than merely stopping being drawn. That is the whole point of it:
    /// this is the busiest message in the room, and a switch that saved nothing
    /// would be a preference rather than a dial.
    show_cursors: bool,
    /// The picture the table is looking at instead of the board, or `None`.
    ///
    /// The fourth room-wide switch, and its three neighbours in every respect
    /// bar one: it carries a URL rather than a flag. **Nothing else in this
    /// struct reads it**, which is the feature — the board, its walls, its
    /// shapes and everywhere the party has explored go on existing untouched
    /// behind the picture, so taking it down puts the table back exactly where
    /// they were. A backdrop is not a map: see `docs/maps.md`.
    backdrop: Option<String>,
    /// Everything the DM has prepared on each map, keyed by its URL: the grid
    /// they calibrated, the walls they traced and the fog they painted.
    ///
    /// Server-side only — it never enters a snapshot or a message, because the
    /// finished `MapInfo` and the board's own `walls` already say everything a
    /// client needs. **The shelf, not a scene list**: it holds what the DM
    /// authored on an image and nothing about play — no tokens, no initiative,
    /// and pointedly no `revealed`. See `docs/maps.md`.
    calibrations: HashMap<String, Prepared>,
    /// The last few states of the room, oldest first, for the DM's undo.
    ///
    /// **Post-state, so the back of it is always the room as it is now.** An
    /// undo pops that and adopts whatever is behind it, which is why the ring is
    /// never empty: it is seeded on boot with the room as it was loaded, and
    /// that entry is the floor rather than a step.
    ///
    /// **A snapshot is `Saved` and not a hand-picked subset**, which is the
    /// whole reason this is affordable. The disk serializer already answers
    /// "what is this room, without the parts that die with the process", so
    /// `clients` and `pending` stay out by construction — restoring a live
    /// socket table from ten commands ago is the one way this feature could hard
    /// fail, and it cannot, because the definition of state was not made twice.
    ///
    /// In memory only. It is not on `Saved` itself — a ring inside a ring is a
    /// file that doubles every save — and an evening's undo history is not
    /// something anybody reaches for after a restart.
    ///
    /// **What may go in it is state the undoing hand wrote.** Everything
    /// persisted today qualifies: the shapes a player drew are the room's and
    /// the DM can already erase any of them. Milestone 24's scratchpads will
    /// not — one box of text per person, private to its author — and restoring
    /// those from ten commands ago would silently eat somebody's paragraph with
    /// nothing on screen to say so. When they land, they come out of here.
    undo: VecDeque<Snapshot>,
    /// What has been said this session, oldest first.
    ///
    /// **Memory only, and deliberately not on `Saved`.** Two things fall out of
    /// that and neither needed a rule of its own: old whispers are never durable
    /// on a disk somebody could read, and an undo cannot eat what the table said
    /// — a snapshot is a `Saved`, so this is not in one, so `adopt` leaves it
    /// exactly where it is. Milestone 22 wrote down that the ring may only hold
    /// state the undoing hand wrote; this is the first thing to test it, and it
    /// passes by not being persisted at all.
    ///
    /// A `VecDeque` because the cap trims from the front — the oldest line goes
    /// when the newest arrives, which is what a cap on a conversation means.
    ///
    /// **Not filtered here.** The room holds every line; who may see which is
    /// `chat_seen`, asked per recipient in `snapshot_for` and in `message_for`.
    chat: VecDeque<ChatLine>,
    /// One box of text per person, private to whoever wrote it — the DM's is no
    /// different from anyone else's.
    ///
    /// **The first state in this project the DM is not sent**, and every
    /// asymmetry before it runs the other way: `snapshot_for` and `message_for`
    /// have only ever been asked to withhold *downward*. There is no `is_dm` in
    /// either arm here, because a scratchpad somebody else's client can open is
    /// not a scratchpad — it is a surveillance feature, and nobody writes
    /// honestly in a box they know is read.
    ///
    /// Persisted, unlike `chat` above it, which is what makes it worth having at
    /// all over the Notepad window everyone already tabs to: it is in the window
    /// and it survives the Pi being rebooted. Being persisted is also what makes
    /// it the case milestone 22's rule was written for — see the `Undo` arm of
    /// `apply`, which is the one place a restore is told to leave something
    /// alone.
    ///
    /// Keyed by `Owner` and never by anything a client says: `SetNotes` carries
    /// no key, because a key a client could name is a key it could name
    /// somebody else's with.
    notes: HashMap<Owner, String>,
    /// Which colour each player picked for themselves.
    ///
    /// **The scratchpads' opposite in the one respect that decides everything
    /// else about it: this is public.** A colour is only worth picking because
    /// the other six screens draw your ring and your lines in it, so `snapshot_for`
    /// hands the whole table to everyone and there is no filter here at all.
    /// It is still *yours to write* — `SetColour` names no slot, exactly as
    /// `SetNotes` names no box.
    ///
    /// Persisted, which put it on the undo ring by construction and took the
    /// hand-written exemption `notes` above already needed — see the `Undo` arm
    /// of `apply`. It is the second thing to want that exemption, which is what
    /// turned milestone 22's rule from a special case into a rule: **the ring
    /// holds state the undoing hand wrote**, and a player's colour is not the
    /// DM's to take back.
    ///
    /// Keyed by `PlayerId` and not by `Owner`, which is the type saying the DM
    /// has no entry here rather than a check saying so. Their hue is outside the
    /// six on purpose.
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
/// behind it is undoing the thing this one is named after. That is why the
/// button reads the label off the back of the ring rather than the one before
/// it — with no redo, the DM has to be told what a press takes before they take
/// it.
struct Snapshot {
    /// Never read on the seed entry, which nothing arrived at. It is a real
    /// sentence anyway rather than an empty string, so a bug that shows it reads
    /// as something rather than as a blank button.
    did: String,
    state: Saved,
}

/// Starts one room's actor and hands back the handle sockets reach it through.
///
/// `roster` is the room's cast and `demo` says whether a missing save file means
/// the built-in board or an empty one — both come from `ROOMS`, and both are the
/// caller's to look up so that this function knows about a room rather than
/// about the table of them.
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
                state.remove_client(client);
                // Who happens to be connected is not part of the room. That
                // sentence is why `persists` refuses `PresenceChanged` and why
                // this arm still returns `false` having just sent one.
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
        // Three switches the DM flipped once and expects to find flipped next
        // week.
        | Event::NamesChanged
        | Event::DiagonalsChanged
        | Event::CursorsChanged
        // And the picture the DM left up, for the same reason: a room reopened
        // on Saturday should be looking at whatever it was looking at.
        | Event::BackdropChanged
        | Event::InitiativeChanged
        | Event::MapChanged
        | Event::StagedChanged
        | Event::ShapesChanged
        // Half an hour of tracing. The one thing in the room where losing the
        // last two seconds of work would mean losing the segment the DM was
        // most likely to be in the middle of.
        | Event::WallsChanged { .. }
        // Only `revealed` is on disk, and only it can have grown here. Riding
        // along with the drop that caused it costs nothing — that frame already
        // marked the room dirty — and a session's exploration surviving a
        // restart is the difference between a map and a map with a memory.
        | Event::FogChanged
        // The walls' argument again: this is somebody's work, and nothing in the
        // room could reconstruct it from anything else if the file lost it.
        | Event::OverridesChanged { .. }
        // An undo moves the room to a state it held before, which is as much a
        // change to what is on disk as the command it took back was. Leaving it
        // out would let the file keep the undone version until something else
        // happened to be saved.
        | Event::Restored => true,
        // A sketch is not in the room to be saved. It is the one thing here
        // that exists only between two pointer events, which is exactly why a
        // measuring line costs the disk nothing at all.
        //
        // A ping is that argument taken further: a sketch exists between two
        // pointer events and this exists after one, so there has never been a
        // moment at which the room held it. Restoring a ping would be restoring
        // the fact that somebody once pointed at something.
        //
        // `UndoChanged` is the same argument from a different direction: the
        // ring lives in memory and is not on `Saved` at all, so there is nothing
        // here for a write to capture. It rides beside events that do persist,
        // which is why this arm never suppresses a save that was wanted.
        //
        // A line of talk is the one thing here the room *does* keep and still
        // does not write down, which makes it the odd arm in this list rather
        // than another ephemeral one. It is session memory on purpose: what was
        // whispered on a Tuesday is not something this project should be storing
        // on a disk in somebody's front room, and an evening's initiative rolls
        // are worth nothing the morning after. That one decision is also what
        // keeps it out of the undo ring, since a snapshot is whatever `Saved`
        // describes.
        //
        // And presence is the one arm here that refuses on a principle rather
        // than on the thing being fleeting. The room already wrote the sentence
        // in the `Disconnected` arm — *who happens to be connected is not part
        // of the room* — and a file that recorded it would boot claiming five
        // people were in a house nobody is in.
        //
        // And a cursor is the ping's argument taken as far as it goes. A ping
        // existed for the instant somebody chose to send it; this is true for a
        // sixteenth of a second and is not a decision anybody made. There has
        // never been a moment at which the room held one, and a file that
        // recorded one would be recording where a hand was on a Tuesday.
        Event::Sketching { .. }
        | Event::SketchEnded { .. }
        | Event::Pinged { .. }
        | Event::CursorMoved { .. }
        | Event::Said { .. }
        | Event::PresenceChanged
        | Event::UndoChanged => false,

        // And the two that are `Said`'s opposite on this list: the room keeps
        // these *and* writes them down. Surviving a restart is most of what a
        // scratchpad is worth, and a colour picked once at the start of a
        // campaign that had to be picked again every session would not be worth
        // picking. They are the two things a player writes that reach the disk,
        // which is also what makes them the two the undo ring has to be told to
        // leave alone.
        Event::NotesChanged { .. } | Event::ColoursChanged => true,
    }
}

/// What this command should be called on the undo button, or `None` for one
/// that is never a step to go back to.
///
/// **`persists`'s and `moves_sight`'s third sibling**, enumerated the same way
/// and for the same reason: a command added later and forgotten here silently
/// stops being undoable, which reads as the ring being shallow rather than as a
/// missing arm.
///
/// The two lists are asked together — a step exists when a command has a label
/// *and* produced something worth writing to disk — so this one does not have to
/// re-derive which commands change the room. What it adds is the two exclusions
/// `persists` cannot express, and they are the interesting part:
///
/// - **`Undo` itself.** Undoing pushes nothing, or the ring would grow a new top
///   every time the DM walked back down it and the second press would return to
///   where the first one started.
/// - **Commands nobody authored a change with**, which is `Hello` and the three
///   ephemeral ones. They persist nothing either, so this is belt and braces
///   rather than the only guard.
///
/// The labels complete "undo …" and are written the way the DM would say what
/// they did, not the way the protocol spells it. They are `&'static str` rather
/// than built from the room: a name looked up here would be the name *after* the
/// change, so undoing a rename would offer to undo the new name.
fn undid(msg: &ClientMsg) -> Option<&'static str> {
    match msg {
        // A drag frame is not a step of its own — `persists` already says so,
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
        // Named for what it does rather than for which way it went, like the
        // map's label above: "the backdrop" is true whether the DM put one up
        // or took one down.
        ClientMsg::SetBackdrop { .. } => Some("the backdrop"),
        // Loading and recalibrating are one command, so this label has to cover
        // both without claiming which — "the map" is true either way.
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
        // See above: the two exclusions, and the first is the load-bearing one.
        ClientMsg::Undo => None,
        ClientMsg::Hello { .. }
        | ClientMsg::Sketch { .. }
        | ClientMsg::Ping { .. }
        // Where a hand is is not a step in anything. It persists nothing, so
        // this arm is the belt-and-braces half rather than the rule.
        | ClientMsg::MoveCursor { .. }
        // Nothing anybody said is the DM's to take back, and the exclusion is
        // free rather than argued: this persists nothing, so the pair would
        // never agree about it anyway.
        | ClientMsg::Say { .. }
        // **The third exclusion, and the first that `persists` disagrees with.**
        // Milestone 22's rule is that the ring may only hold state the undoing
        // hand wrote, and a scratchpad is the case it was written for: undoing
        // somebody's paragraph away would be a stranger's button eating work
        // there is no way to get back and nothing on screen to explain. Leaving
        // it off the ring is only half of that — see the `Undo` arm of `apply`
        // for the other half, which is a restore being told to leave a box it
        // did not write alone.
        | ClientMsg::SetNotes { .. }
        // **The fourth exclusion, and the second that `persists` disagrees
        // with.** A colour is somebody else's the same way a scratchpad is, and
        // the DM's undo reaching across the table to change what colour a player
        // draws in is the same surprise with nothing on screen to explain it.
        // Two instances is what makes milestone 22's rule a rule: the ring holds
        // state the undoing hand wrote. The other half is in the `Undo` arm of
        // `apply`, and it is needed here for the identical reason — a colour
        // picked *between* two commands is on the snapshot the later one pushed.
        | ClientMsg::SetColour { .. } => None,
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
        // Geometry and paint each name a board, exactly as a token move does, and
        // for the identical reason: **nothing on the staged board casts a shadow
        // on this one.** There is no staged fog for a staged wall to block or a
        // staged override to mask, so tracing the next dungeon must not recompute
        // this one's sight — which would be a raycast per click of a two-hundred
        // segment trace, all of it to find nothing had changed.
        ClientMsg::AddWalls { staged, .. }
        | ClientMsg::RemoveWall { staged, .. }
        | ClientMsg::ToggleDoor { staged, .. }
        | ClientMsg::ClearWalls { staged }
        | ClientMsg::SetFogOverride { staged, .. } => !staged,
        // Any of these can add, remove or re-own a vision source — handing a
        // token to a player is how somebody gains one — or move the lattice the
        // cells are counted on, or change what blocks a ray.
        //
        // `SetMap` is on this list whichever slot it names, unlike the five
        // above: filling the staged slot sweeps that board's tokens, and a
        // promote is the moment everything staged becomes what the party is
        // looking at.
        ClientMsg::CreateToken { .. }
        | ClientMsg::UpdateToken { .. }
        | ClientMsg::DeleteToken { .. }
        | ClientMsg::SetMap { .. }
        | ClientMsg::PromoteStaged
        | ClientMsg::ClearStaged
        // The one command here that changes what the party can see without
        // changing anything about the room they are looking at. The mask is
        // applied inside `recompute_sight`, so it needs no arm of its own
        // anywhere else. It names no slot: there is no staged fog to reset.
        | ClientMsg::ResetFog => true,
        // Nothing drawn on the board occludes anything, a sketch is not in the
        // room at all, the turn order is a panel, and a label is written over
        // the light rather than in it.
        ClientMsg::Hello { .. }
        | ClientMsg::SetShowNames { .. }
        // A pointer is drawn over the light like the ruler is, and switching
        // every pointer off changes what is on a screen rather than what a ray
        // reaches.
        | ClientMsg::SetShowCursors { .. }
        // A picture in front of the board is drawn over the light in the most
        // literal sense available: the board is still there, still lit exactly
        // as it was, with something in front of it.
        | ClientMsg::SetBackdrop { .. }
        | ClientMsg::MoveCursor { .. }
        // A ruler is drawn over the light and never in it, and this only
        // changes what the ruler says.
        | ClientMsg::SetDiagonals { .. }
        | ClientMsg::Sketch { .. }
        | ClientMsg::AddShape { .. }
        | ClientMsg::RemoveShape { .. }
        | ClientMsg::ClearShapes
        // Pointing at a room does not light it. This is the arm that would be
        // tempting to write the other way round — a ping lands on unexplored
        // ground and stays a ring over black, deliberately.
        | ClientMsg::Ping { .. }
        // Words are not on the board at all. The fog does not apply to them and
        // they do not apply to it.
        | ClientMsg::Say { .. }
        // A box of text on one person's screen is not on the board either, and
        // this one is not even in the room the others are looking at.
        | ClientMsg::SetNotes { .. }
        // What colour a ring is drawn in is not what a ray reaches.
        | ClientMsg::SetColour { .. }
        | ClientMsg::SetInitiative { .. }
        | ClientMsg::RemoveFromInitiative { .. }
        | ClientMsg::ClearInitiative
        | ClientMsg::NextTurn
        | ClientMsg::PreviousTurn
        // **The one arm here that is false because it does its own.** An undo
        // moves the walls, the tokens and the party's memory at once, so sight
        // certainly changes — but the frame it produces carries a whole
        // `RoomView` with the fog already in it, and `refresh_fog` on top would
        // send everyone a second, redundant description of the same board.
        // `apply` recomputes there instead. See `ClientMsg::Undo`.
        | ClientMsg::Undo => false,
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

/// Whether this identity is one of the two ends of a line somebody said.
///
/// **The whole visibility rule for the chat log, and it is a rule about two
/// people rather than about a role.** A shout is everybody's. A whisper is in
/// exactly two copies — the sender's and the recipient's — which is why this
/// asks about `by` as well as about `to`: without the first half the DM's own
/// whisper to Saelyn would be absent from the DM's log, and the person who said
/// it would be the one person unable to see it.
///
/// It takes an `Identity` rather than a `Client` because both callers have one
/// and neither has the other: `snapshot_for` is handed an identity, and
/// `message_for` looks one up per recipient.
///
/// A free function beside `can_move` and `can_erase`, for the reason those two
/// are: it needs nothing from the room. `shape_seen` is on `RoomState` because
/// it has to ask where the party is standing; this asks nothing of the board at
/// all, which is the difference between hiding a monster and hiding a sentence.
fn party_to(identity: &Identity, line: &ChatLine) -> bool {
    let is = |owner: &Owner| is_owner(identity, owner);
    match &line.to {
        // Filtered by nothing at all. The fog does not apply to words, and this
        // is the arm that says so.
        ChatTo::Table => true,
        ChatTo::Dm => matches!(identity, Identity::Dm) || is(&line.by),
        ChatTo::Player(id) => matches!(identity, Identity::Player(me) if me == id) || is(&line.by),
    }
}

/// Whether this identity is the person that `Owner` names.
///
/// The one question `Identity` and `Owner` can be asked together, pulled out
/// because two features now ask it for different reasons: `party_to` asks it
/// about the ends of a whisper, and `notes_for` asks it about the only box a
/// client may hold. It is `drawn_by`'s inverse and stays a free function for the
/// same reason that one is — it needs nothing from the room.
fn is_owner(identity: &Identity, owner: &Owner) -> bool {
    match (identity, owner) {
        (Identity::Dm, Owner::Dm) => true,
        (Identity::Player(me), Owner::Player(them)) => me == them,
        _ => false,
    }
}

/// The roster is not persisted: it is a constant, and a saved copy would only
/// be able to disagree with it. It becomes state when the DM can edit it.
///
/// **Which constant is now the room's to say**, which is the only thing
/// multi-room changed about the cast list: a `RoomState` is handed its roster
/// rather than reaching for the one there used to be, so a slug that names a
/// slot in one room names nothing in another. `hello` already refuses a
/// `player_id` that is not in `self.roster`, so that isolation costs no new
/// line — see the handshake tests.
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
    /// A room off disk. Everything the file does not carry — the DM secret, the
    /// roster, who is connected — comes from the environment or starts empty.
    /// A room holding nothing, and the base both ways of getting one build on.
    ///
    /// The fields here are exactly those a `Saved` does not describe: who the DM
    /// is, the cast list, the undo ring and the two client tables. Everything
    /// else is placeholder, and `adopt` writes over all of it.
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
            backdrop: None,
            calibrations: HashMap::new(),
            undo: VecDeque::new(),
            chat: VecDeque::new(),
            notes: HashMap::new(),
            colours: Colours::new(),
            clients: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    fn restored(saved: Saved, dm_secret: String, roster: Vec<RosterEntry>) -> Self {
        let mut state = Self::empty(dm_secret, roster);
        state.adopt(saved);
        state.floor();
        state
    }

    /// A room with no save on disk and no demo content: an empty board with a
    /// cast standing by.
    ///
    /// `restored` with nothing to adopt, and the third constructor rather than a
    /// flag on one of the other two because it is the answer to a different
    /// question. `hardcoded` is what a *fresh checkout* looks like, so that there
    /// is something on the screen; this is what a *new room* looks like, and
    /// seeding a Halloween one-shot with the campaign's party is worse than
    /// seeding it with nothing. Ends in `floor` for the reason both its
    /// neighbours do.
    ///
    /// **It keeps the built-in map, which is the one thing `empty` gives it that
    /// an empty room does not want to be without.** `MapInfo::default` has no
    /// URL at all, and a client handed one cannot load an image, never builds
    /// its stage and draws nothing — a new room would open as a black page with
    /// a working rail on it. This is not demo content: it is the placeholder the
    /// DM's first `SetMap` replaces, exactly as it is in the room that predates
    /// this one. Everything that would need clearing — tokens, walls, fog,
    /// initiative — is still empty.
    fn blank(dm_secret: String, roster: Vec<RosterEntry>) -> Self {
        let mut state = Self::empty(dm_secret, roster);
        state.map.url = BUILT_IN_MAP.to_owned();
        state.floor();
        state
    }

    /// Puts the room as it stands on the undo ring as the entry nothing goes
    /// back past.
    ///
    /// **Both constructors end with this, and it is not `spawn`'s job** — unlike
    /// `recompute_sight`, which is derived from state and so is done once where
    /// the room is started. A ring with no floor is not a room that needs
    /// recomputing, it is a room whose *first* command cannot be undone: the
    /// step it pushes becomes the bottom of the ring, and `undo_label` correctly
    /// reports there is nowhere to go. Putting it here is what makes a
    /// `RoomState` built by hand — which is every test in this crate — obey the
    /// same rule the server does.
    fn floor(&mut self) {
        self.remember("loaded the room");
    }

    /// Takes a `Saved` as the truth for everything it describes, leaving
    /// everything it does not alone.
    ///
    /// **`to_saved`'s inverse, and the only one** — booting from disk and
    /// undoing are the same operation against the same definition of state, so
    /// they share this rather than each listing the fields. Two lists here is
    /// the milestone-20 trap in a new place: a field added to `Saved` and read
    /// in only one of them loads correctly and undoes to a stale value, or the
    /// reverse.
    ///
    /// What it deliberately does not touch is what a `Saved` has no opinion
    /// about: `dm_secret`, `roster`, `clients`, `pending`, and the ring itself.
    /// **That last one is what makes undo safe** — restoring the socket table
    /// from ten commands ago would hand the room a list of clients that have
    /// since disconnected, and restoring the ring would make the second undo
    /// walk back into a history that had already been rewound.
    fn adopt(&mut self, saved: Saved) {
        self.map = saved.map;
        // The one field on the file whose shape changed rather than gaining a
        // sibling, which is why `StagedView` flattens its map — see the test
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
        // Both derived from where the tokens are standing and what the DM
        // painted, all of which the same `Saved` holds — so they are recomputed
        // rather than restored. That is what stops a save written before a door
        // was shut from describing sight through it, and it is why every caller
        // of this is followed by `recompute_sight`.
        self.known = HashSet::new();
        self.visible = HashSet::new();
        // Restored whole, unlike the two above. Sight is derived from what the
        // file already holds; what the DM decided is not derivable from
        // anything, so losing it would lose the work.
        self.overrides = fog::unpack_overrides(&saved.overrides);
        self.show_names = saved.show_names;
        self.diagonals = saved.diagonals;
        self.show_cursors = saved.show_cursors;
        self.backdrop = saved.backdrop;
        self.calibrations = saved.calibrations;
        // Restored here like everything else, because this has one inverse and
        // two field lists would be the trap `docs/undo.md` names: a field read
        // in `restored` and forgotten in the undo arm loads correctly and undoes
        // to a stale value, and neither shows up as an error.
        //
        // **The undo arm is where a scratchpad is exempted, not this one.** Boot
        // wants these back; a restore does not, and saying so once at the call
        // site that means it is what keeps this function the single answer to
        // "what is a saved room".
        self.notes = saved
            .notes
            .into_iter()
            .map(|note| (note.by, note.text))
            .collect();
        // The field above's twin, and exempted at the same call site for the
        // same reason: boot wants these back, an undo does not.
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
            backdrop: self.backdrop.clone(),
            calibrations: self.calibrations.clone(),
            // Sorted for the tokens' reason: `HashMap` order varies per process,
            // and an unsorted list would rewrite the whole file every time
            // anybody typed.
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
            // both the room's shape and the file's, which is the whole of what
            // `PlayerId` being a legal JSON key buys over the list above.
            colours: self.colours.clone(),
        }
    }

    /// Puts the room as it stands now on the undo ring, labelled with what was
    /// just done to it.
    ///
    /// Called *after* the change, which is what makes the back of the ring the
    /// present. The alternative — snapshotting before every command and throwing
    /// it away when nothing came of it — costs a clone of the whole room on
    /// every drag frame, thirty times a second from each of six people, to
    /// discard all but one of them.
    fn remember(&mut self, did: &str) {
        self.undo.push_back(Snapshot {
            did: did.to_owned(),
            state: self.to_saved(),
        });
        // One more than the number of undos, because the back of the ring is
        // where the DM already is rather than somewhere to go back to.
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

    /// The room a first boot starts from, with no save on disk yet. Milestone 6
    /// replaces the map from the browser.
    ///
    /// **The primary room's first boot alone**, and it names `ROSTER` directly
    /// rather than being handed a cast: the tokens below *are* that roster
    /// written out, so a version of this that took any roster would put six
    /// tokens called Cleodara and Saelyn on somebody else's board. Every other
    /// room starts at `blank`.
    fn hardcoded(dm_secret: String) -> Self {
        // The art is named separately rather than derived from the name: a
        // character called "Captain Bronzebeard" is a file called
        // `bronzebeard.png`, and these are stand-ins anyway — the real portraits
        // are picked out of the library onto whichever tokens end up being used.
        let party = |id: &'static str| Owner::Player(PlayerId::new(id));
        // Built below, then floored at the end — see `restored`, which does the
        // same thing one line later for the same reason.
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
            // On, which is what the board did before there was a switch. A first
            // boot is a room with eight named tokens and nothing else to tell
            // them apart yet.
            show_names: true,
            // What the ruler did before there was a switch, which is the same
            // rule the line above follows to the opposite value.
            diagonals: Diagonals::Equal,
            // On, and the one of the three that no earlier behaviour decides —
            // there were no cursors at all before there was a switch. A feature
            // that ships off is a feature a table never discovers.
            show_cursors: true,
            // Nothing in front of the table, which is what a fresh room and
            // every room that predates this field are both looking at.
            backdrop: None,
            calibrations: HashMap::new(),
            undo: VecDeque::new(),
            chat: VecDeque::new(),
            notes: HashMap::new(),
            // Empty, so every slot draws in the default its roster position
            // gives it — which is what a room that predates this table does too.
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
        // Read before `apply` for the same reason as the line above, and a
        // sharper one: this describes the command, and `apply` consumes it.
        let did = undid(&msg);

        let mut events = self.apply(origin, msg);
        if let Some(before) = before {
            let more = self.refresh_fog(before, &events);
            events.extend(more);
        }

        let dirty = events.iter().any(persists);
        // **A step is a command with a label that actually changed something.**
        // Both halves matter: `persists` alone would record an undo as a step to
        // undo, and a label alone would record a `SetMap` that was refused
        // deeper in `apply` than `check` could see.
        //
        // After the fog, because the snapshot is the room as it now stands and
        // `refresh_fog` may have grown `revealed` — which is on disk, so a
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
        // After the insert, so the list this describes includes whoever just
        // arrived — and so they are in it on their own screen. They were also
        // told by the `Welcome` above, which carries the same list through
        // `snapshot_for`; the two agreeing is invariant 3 rather than a
        // duplicate, and a repaint of the same chips is what the second costs.
        //
        // `refresh_pickers`' neighbour and its opposite number: that one tells
        // the undecided which *slots* are taken, this tells the table which
        // *people* are here. Both are the socket table changing and neither is
        // the room changing, which is why this returns nothing to save.
        self.dispatch(origin, &[Event::PresenceChanged]);
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

    /// Who is connected, the DM among them.
    ///
    /// `roster_slots`'s neighbour and deliberately not the same answer. That one
    /// describes *slots* and is for somebody choosing one; this describes
    /// *people* and is for everybody who already has. The difference that
    /// decides which is which is the DM, who occupies no slot and is the
    /// connection a table most wants to be sure of.
    ///
    /// **Deduplicated**, because `RosterSlot::claimed` already records that one
    /// person on a laptop and a phone is legitimate — two sockets there are one
    /// name here, and counting sockets would put seven people at a table of six.
    ///
    /// Ordered: the DM, then the roster's own order. Nothing downstream depends
    /// on it — the strip draws every slot and dims the absent ones, so it never
    /// reflows — but a list whose order varied per process would make a test
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
            // One `None` withholding three things rather than one, which is what
            // the bundle bought: the next dungeon's map, its masonry and its
            // paint leave by a single door, and there is no second staged field
            // for a later milestone to add and forget to filter here.
            staged: match identity {
                Identity::Dm => self.staged.as_ref().map(StagedBoard::view),
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
                self.overrides_for(false)
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
            // And a third time, with a second job: this one is read by the
            // client to decide whether to *send*, so a join that omitted it
            // would leave every fresh page shipping its pointer into a room that
            // has switched cursors off.
            show_cursors: self.show_cursors,
            // And a fourth time, for the plainest version of the reason: the DM
            // decides what is on the screens and there is nothing here to keep
            // from anybody. A join that omitted it would put a fresh page back
            // on the board while the rest of the table looked at the campfire.
            backdrop: self.backdrop.clone(),
            // And the same a fifth and sixth time. Neither is anybody's secret:
            // the point of one is that the table can see whether the DM is still
            // there, and the point of the other is that six other screens draw
            // your ring in the colour you chose.
            here: self.here(),
            colours: self.colours.clone(),
            // And back to the walls' rule to finish, which is where this list
            // started: the DM's next undo, and `None` for everybody else. A
            // player has no button for it to label, and `None` is also what an
            // untouched room says — indistinguishable, like an empty wall list.
            undo: if is_dm { self.undo_label() } else { None },
            // And a rule none of the fields above uses, on the last one: this is
            // filtered by *which person* rather than by whether they are the DM.
            // `is_dm` is not enough to answer it and is not asked — a whisper
            // between the DM and Saelyn is Saelyn's as much as it is theirs.
            chat: self.chat_for(identity),
            // And a rule the line above nearly shares, pointed the other way. It
            // is filtered by which person too — but where a whisper has two ends
            // and the DM is one end of all of them, a scratchpad has one end and
            // the DM has no standing in anybody's but their own.
            notes: self.notes_for(identity),
        }
    }

    /// This client's own scratchpad, and there is no other question to ask.
    ///
    /// **The only `*_for` on this impl that gives the DM less than the room
    /// holds.** Every other one narrows for a player and hands the DM the whole
    /// of it; there is no `is_dm` here, and adding one would not be a widening
    /// of a filter but the deletion of the feature — a box somebody else can
    /// read is not a box anybody writes honestly in.
    ///
    /// Invariant 3 is what makes this a function rather than a field read at the
    /// call site: a join and a restore both come through here, so there is no
    /// second place for the whole table's notes to escape from.
    fn notes_for(&self, identity: &Identity) -> String {
        self.notes
            .iter()
            .find(|(owner, _)| is_owner(identity, owner))
            .map(|(_, text)| text.clone())
            .unwrap_or_default()
    }

    /// This session's talk as this recipient may see it.
    ///
    /// **Two clients get two different conversations out of this, not one
    /// conversation with rows missing.** Every other `*_for` on this impl
    /// narrows the room's single copy of something; here the room's copy is a
    /// pile of private exchanges that no client is ever entitled to whole, the
    /// DM included — they see every whisper because they are one end of all of
    /// them, not because they are the DM.
    ///
    /// Invariant 3 with the sharpest teeth in the project: filtering the deltas
    /// and forgetting this would hand a joining player the whole evening's
    /// whispers in one frame.
    fn chat_for(&self, identity: &Identity) -> Vec<ChatLine> {
        self.chat
            .iter()
            .filter(|line| party_to(identity, line))
            .cloned()
            .collect()
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

    /// Whether this recipient may be shown a pointer at `at`.
    ///
    /// **The whole of milestone 28's filter, and it is asymmetric on purpose.**
    /// Three of the four cases are yes and only one is no: the DM sees every
    /// pointer, because they can see the whole board already; a *player's*
    /// pointer is relayed wherever it goes, because a player can only point at
    /// what their own client drew; and an unfogged map has nothing to withhold.
    /// What is left is the DM's pointer over ground the party has not explored,
    /// and that is the one case worth a filter at all — the DM's hand lingers
    /// where the DM is working, which is over the ambush in the unlit chamber.
    ///
    /// **`known` and not `visible`**, which is the same split every other reader
    /// downstream of the fog makes: a pointer is over the terrain rather than
    /// standing on it, so it goes with the explored map and not with the
    /// creatures. That means it inherits the fringe and the DM's own mask for
    /// free — a room the DM has painted `Dark` swallows their pointer too, which
    /// is the honest reading of having blacked it out.
    ///
    /// The `map.fog` guard is load-bearing and is `shape_seen`'s: `known` is
    /// empty on an unfogged map, so without it the DM's pointer would vanish
    /// from every player's board the moment fog was switched off.
    fn cursor_seen(&self, by: &Owner, at: Pos, to_dm: bool) -> bool {
        if to_dm || !matches!(by, Owner::Dm) || !self.map.fog {
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
    /// would be a strange thing to explain.
    ///
    /// Asked of `Token::unseen` and deliberately not of `unseen_by_table`, which
    /// would be circular — what the party can see cannot be an input to computing
    /// what the party can see.
    fn vision_sources(&self) -> Vec<Pos> {
        let mut sources: Vec<Pos> = self
            .tokens
            .values()
            .filter(|t| matches!(t.owner, Owner::Player(_)) && !t.unseen())
            .map(|t| Pos { x: t.x, y: t.y })
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

    /// Recomputes what the party can see and applies the DM's overrides over the
    /// top.
    ///
    /// Three sets come out of one reading. Which question that reading asks is the
    /// map's — `fog::sight_cells` casts rays on a `Dynamic` map and floods rooms on
    /// a `Room` one — and **nothing below this line knows which**: the mode changes
    /// what the party can see and not what any of that means, which is why it
    /// bought no arm here, no arm in `message_for` and no third derived set.
    ///
    /// **Only the rays reach `revealed`**, and the mask makes the other two:
    ///
    /// ```text
    /// revealed ∪= rays                          // memory, persisted, rays only
    /// visible   = rays  ∪ Lit − Dark            // in sight now
    /// known     = fringe(revealed) ∪ Lit ∪ Explored − Dark   // shown as terrain
    /// ```
    ///
    /// The fringe is one cell of terrain past everywhere the rays reached, and it
    /// is a mask over `revealed` for the same reason the overrides are: memory is
    /// rays only, so the widening is recomputed from it every time rather than
    /// written into it, cannot be baked into a save, and lifts the moment the
    /// grid moves under it. `with_fringe` in `fog.rs` says what it is for.
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
    /// `visible ⊆ known` still holds — `fringe(revealed) ⊇ revealed ⊇ rays`, and
    /// the mask does the same thing to both — which is what lets `FogView` pack
    /// both facts into one character per cell. The first of those is by
    /// construction rather than by argument; see `with_fringe`.
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
        if self.map.fog {
            let rays = fog::sight_cells(&self.map, &self.walls, &self.vision_sources());

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

        // Last, and after both branches rather than inside the fogged one: an
        // unfogged map shows the table every token, and a room that has just had
        // its fog switched off has to record that as much as one that recomputed
        // a raycast.
        //
        // **This is the only moment the room and what the table holds are the
        // same thing**, which is why it is written down here instead of being
        // asked for later. Everything that can change the answer recomputes —
        // `moves_sight` enumerates it — with the single exception of a drag
        // frame, and a drag frame is exactly the case this exists to survive.
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

    /// The board a command named, or `None` when it named the staged slot and
    /// nothing is staged.
    ///
    /// `shownBoard`'s server-side counterpart, and it exists for the same reason:
    /// without one function answering "which of the two", every arm below grows
    /// an `if staged` and the one that forgets writes the next dungeon's masonry
    /// across the board the table is looking at.
    ///
    /// Three accessors rather than one returning a struct, because the borrow
    /// checker cares which of them is mutable and the callers each want one.
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
            // anyway — the same indistinguishability a player's copy relies on.
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
            ClientMsg::SetShowCursors { .. } => require_dm(client, "set what the boards draw"),

            // Bounded by the one rule `SetMap` bounds a URL with, and by no
            // other: there is nothing else here to check. The picker only ever
            // sends a path the pick route just handed back, so this is a bound
            // on a hostile frame rather than on the panel.
            ClientMsg::SetBackdrop { url } => {
                require_dm(client, "put a picture in front of the table")?;
                if let Some(url) = url
                    && (url.is_empty() || url.len() > MAX_URL_LEN)
                {
                    return Err("that backdrop URL is not a usable length".to_owned());
                }
                Ok(())
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
                fog: _,
                vision_ft,
                // Nothing to bound: serde has already refused anything that is
                // not one of the two variants, and either is a legitimate thing
                // for the DM to ask for — what is said of `fog` below.
                lighting: _,
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
                // only thing that stops the loop being unbounded — in both
                // lighting modes, since the room fill is bounded by the radius
                // as well as by the walls.
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

            // Anyone may say something, and the whole of the permission is
            // *where it is going*. There is no `require_dm` here and there is no
            // per-item rule underneath it either — what a player may not do is
            // name another player, which is one arm of the match below rather
            // than a rule about who they are.
            //
            // The refusals are worded as the boundary rather than as a
            // restriction, because a player whose message bounces should learn
            // that this is not a thing Slate does, not that they lack a
            // permission somebody else has.
            ClientMsg::Say { to, text } => {
                let text = text.trim();
                if text.is_empty() {
                    return Err("there is nothing to say".to_owned());
                }
                if text.chars().count() > MAX_CHAT_LEN {
                    return Err(format!("that is longer than {MAX_CHAT_LEN} characters"));
                }
                match (&client.identity, to) {
                    // The two everybody has, and the two a player has.
                    (_, ChatTo::Table) => Ok(()),
                    (Identity::Player(_), ChatTo::Dm) => Ok(()),
                    // The DM whispering one player, which is the only reason
                    // this variant exists — and it names a real slot, so a
                    // whisper cannot be addressed into nowhere.
                    (Identity::Dm, ChatTo::Player(id)) => {
                        if self.roster.iter().any(|entry| &entry.id == id) {
                            Ok(())
                        } else {
                            Err("nobody by that name is at this table".to_owned())
                        }
                    }
                    // Player to player, which is the line this feature is drawn
                    // to not cross.
                    (Identity::Player(_), ChatTo::Player(_)) => {
                        Err("you can whisper the DM or shout to the table".to_owned())
                    }
                    // The DM whispering themselves. Refused rather than quietly
                    // delivered, for the reason a promote with nothing staged is
                    // refused: it means a client and the room disagree about what
                    // the controls are.
                    (Identity::Dm, ChatTo::Dm) => {
                        Err("you are the DM — shout, or whisper a player".to_owned())
                    }
                }
            }

            // Anyone may write in their own box, and there is no permission
            // underneath that at all — not a role, not a destination, not an
            // owner to compare. The command names no box, so the only one it
            // can reach is the sender's, which is the check this arm does not
            // have to make. Everything below is about size and shape.
            ClientMsg::SetNotes { text } => {
                if text.chars().count() > MAX_NOTES_LEN {
                    return Err(format!("a scratchpad holds {MAX_NOTES_LEN} characters"));
                }
                Ok(())
            }

            // The arm above with one thing to check instead of none, and the
            // check is a closed set rather than a length — a token's size in a
            // different costume. What it must not become is a colour string: the
            // six hues are chosen to be unmistakeable for the token rings the
            // board draws in gold, blue, white, violet and teal, and free hex is
            // a player making their own ring say something false about a
            // creature.
            //
            // The DM is refused outright. Their hue is outside the six because
            // theirs is the one ring at the table that is not a player's, and
            // that is a rule about the board rather than about a control — so it
            // is kept here, where it is true whatever a client sends.
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
            // no state, so the only thing it could corrupt is a save file it
            // never reaches — and `finite` is here anyway, because a NaN would
            // reach six clients and draw a ring nowhere.
            ClientMsg::Ping { at } => finite(&[at.x, at.y]),

            // The arm above, and everything it says holds here twice over: the
            // position is written into no state, so `finite` is the whole of it.
            // There is no permission — a pointer is not a thing anybody has to
            // be allowed to have — and pointedly **no check that the room's
            // switch is on**. A client that goes on sending into a room that
            // switched cursors off is wasting its own bandwidth and nobody
            // else's, because `message_for` drops every one of these; refusing
            // it here would turn a switch into a stream of red banners on the
            // screen of whoever had the tab open when it was flipped.
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
            ClientMsg::AddWalls { points, staged, .. } => {
                require_dm(client, "trace walls")?;
                // The staged slot's own rule, before any of the geometry: a run
                // traced onto a slot holding no map has nothing to be traced
                // over. Same refusal `CreateToken` and a staged `MoveToken`
                // already make, and it is not the server learning about preview
                // — it is the slot being empty.
                if *staged {
                    self.staged_slot("trace walls on")?;
                }
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
                // is what the room is actually being asked to grow by. Counted
                // against the board it is being traced on: the cap is what one
                // map's worth of masonry costs, and the two slots each hold one.
                if self.walls_in(*staged).len() + points.len() - 1 > MAX_WALLS {
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
            // Looked up in the slot the command named rather than in both. The
            // ids are UUIDs, so searching both would find it either way — and
            // would erase a live segment on a frame the DM sent while looking at
            // the staged board, which is the bug the flag exists to make
            // impossible rather than unlikely.
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
                    // Refused rather than ignored: a toggle that lands on
                    // masonry means the client and the room disagree about what
                    // that segment is, and quietly doing nothing hides it.
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
                // Refused rather than stored-and-ignored. An override on a map
                // with no fog can have no effect at all, and a command that
                // silently does nothing is worse than one that says why — the
                // panel greys itself for the same reason.
                //
                // Asked of the board the paint is for, which is the whole of
                // what staging changed here: a fogged staged map may be painted
                // while the unfogged live one below it may not, and the DM is
                // preparing the first of those.
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
                // the whole map's worth of characters on every send. Against the
                // named board's own play area, since the two are different
                // images and one of them is usually a different size.
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

            ClientMsg::Undo => {
                require_dm(client, "undo")?;
                // The DM's own button is inert with an empty ring, so reaching
                // here means their client and the room disagree about what is
                // on it — a second DM tab that undid the same step first, most
                // likely. Refused rather than ignored, for `ToggleDoor`'s
                // reason: doing nothing quietly hides the disagreement.
                if self.undo_label().is_none() {
                    return Err("there is nothing to undo".to_owned());
                }
                Ok(())
            }
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

            // The third of the three, unconditional for both reasons above —
            // and the resync one is sharper here than anywhere else, because a
            // client holding a stale `false` has quietly stopped sending its
            // own pointer and nothing on its screen would say why.
            ClientMsg::SetShowCursors { show } => {
                self.show_cursors = show;
                vec![Event::CursorsChanged]
            }

            // **The fourth, and the one arm here that must stay this short.**
            // Everything a DM might expect to happen when the board is covered
            // — sweeping the shapes, forgetting the fog, clearing the walls — is
            // the thing this command exists not to do. One assignment and one
            // event; the board is untouched, so taking the picture down puts the
            // table back exactly where they were.
            ClientMsg::SetBackdrop { url } => {
                self.backdrop = url;
                vec![Event::BackdropChanged]
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
                lighting,
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
                    self.staged.as_ref().map(|board| &board.map.url)
                } else {
                    Some(&self.map.url)
                };
                let loading = showing != Some(&url);
                //
                // **A recalibration writes the calibration and nothing else.**
                // The entry also holds the walls and the paint prepared on this
                // image, and they are not the client's to send — an insert of a
                // whole `Prepared` here would file empty walls over half an hour
                // of tracing every time the DM nudged the grid, and the board
                // would go on showing them until the map was next loaded away
                // from. Assigning the one field is what makes that unsayable.
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

                    // The staged board's own geometry, swept by exactly the rule
                    // the live board's is swept by one branch down — which is the
                    // whole argument for the two slots holding the same three
                    // things. A *load* is a different image and nothing traced on
                    // the last one means anything on it. A **recalibration keeps
                    // the walls and drops the paint**: a wall is image pixels and
                    // still traces the same painted line, and an override is a
                    // cell whose square has just moved out from under it.
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
                    // **The second write site, and the one that gets missed.**
                    // A staged board never passes through `sweep_board`; it dies
                    // right here, where a load discards whatever was in the slot.
                    // The rule is the live board's — what a board had traced on
                    // it is filed under *its* URL as it stops being held — and
                    // the only difference is that the URL and the walls are both
                    // in hand rather than on `self`.
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
                        // carried *across* — but whatever the DM last prepared on
                        // this image comes back off the shelf with it, which is
                        // what lets three dungeons be traced on a Tuesday and
                        // found still traced on Saturday.
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

                    // One event still, and that is the bundle earning its keep:
                    // `StagedChanged` carries the whole slot, so a load that
                    // swept its walls and a recalibration that dropped its paint
                    // are both already described by the frame the DM was getting
                    // anyway. There is no staged `WallsChanged` to remember to
                    // emit beside it, and so none to forget.
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
                    //
                    // The URL of the board being left, read before the
                    // assignment overwrites it. `sweep_board` files what was
                    // traced on it under this, and it cannot work the name out
                    // for itself — see the note on that function.
                    let outgoing = std::mem::replace(&mut self.map, finished).url;
                    let mut events = vec![Event::MapChanged];
                    // The drawings and the walls are the opposite case from the
                    // plans, and turn on `loading`: they describe this image, and
                    // a new one is a new dungeon where none of it means anything.
                    // A recalibration must leave them alone, exactly as it leaves
                    // the plans alone — this is the arm that gets missed.
                    //
                    // **The two arms are exclusive and that ordering is
                    // load-bearing since milestone 31.** A load clears
                    // everything the reshaped arm below clears, so running that
                    // arm first would be harmless — except that it would empty
                    // the overrides *before* the sweep files them, and the DM's
                    // painted fog would go on the shelf as nothing. Whatever a
                    // board is remembered by has to be read while the board
                    // still holds it.
                    if loading {
                        // What the sweep is about to gate its own two events on.
                        // Read here because both events are materialised at
                        // *dispatch* against whatever the board holds then, so a
                        // frame the sweep already pushed will carry the restored
                        // list and a second naming the same one says nothing.
                        let swept = (!self.walls.is_empty(), !self.overrides.is_empty());
                        events.append(&mut self.sweep_board(&outgoing));

                        // And the other half of the shelf: whatever the DM last
                        // traced and painted on the image that just arrived
                        // comes back with it. After the sweep, never before it —
                        // the sweep clears exactly these two.
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
                        // And the DM's overrides, by the identical argument: they
                        // are cells, and the squares they name have just moved
                        // out from under them. This one needs its own event —
                        // nothing recomputes it, so the DM's panel would go on
                        // drawing a mask the room no longer holds.
                        //
                        // The shelf is deliberately not written here: a
                        // recalibration is not the map leaving. What gets filed
                        // is whatever the board is holding when it does leave,
                        // which after this is nothing — the same answer the
                        // board has just given the DM on screen.
                        if !self.overrides.is_empty() {
                            self.overrides.clear();
                            events.push(Event::OverridesChanged { staged: false });
                        }
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
                let Some(board) = self.staged.take() else {
                    return Vec::new(); // proved to exist by `check`
                };

                // Tokens first, so that by the time a client is told the slot
                // has emptied — which is what ends the DM's preview — every
                // token already holds the position it landed on. It reads the
                // fog before the sweep below, which is why the order here has
                // never been free to change.
                let mut events = self.promote_staged_tokens();
                // A promote is a new map arriving on the board, so the drawings
                // go the way they go for any other load, and so does everywhere
                // the party had explored: this is a different dungeon and they
                // have not been in it.
                //
                // **The walls and the paint are what milestone 20 changed.** The
                // sweep still clears the board's, and then the staged board's
                // land in their place rather than nothing landing — which is the
                // whole feature, and the reason `sweep_board` is called before
                // the assignment rather than after it.
                //
                // The URL passed in is the *outgoing* board's, and here that is
                // simply `self.map` — the assignment is on the line below rather
                // than above, which is the whole reason `sweep_board` cannot
                // read it for itself.
                let outgoing = self.map.url.clone();
                events.append(&mut self.sweep_board(&outgoing));
                self.map = board.map;
                self.walls = board.walls;
                self.overrides = board.overrides;
                // Gated the way the sweep's own halves are, and against what
                // *arrived* rather than what left: an empty staged board
                // promoting onto an empty live one is a `WallsChanged` saying
                // nothing happened. `sweep_board` may have emitted one already
                // for the clear, and a second frame naming the new list is the
                // correct order — the DM ends up holding what is actually there.
                if !self.walls.is_empty() {
                    events.push(Event::WallsChanged { staged: false });
                }
                if !self.overrides.is_empty() {
                    events.push(Event::OverridesChanged { staged: false });
                }
                // Then the two that were always here, because two things
                // happened: the board changed for everyone, and the slot emptied
                // for the DM.
                events.push(Event::MapChanged);
                events.push(Event::StagedChanged);
                events
            }

            ClientMsg::ClearStaged => {
                let mut events = self.clear_staged_tokens();
                // The staged slot's other exit, and it files what it is throwing
                // away for the reason the load arm does: the shelf is keyed by
                // image, not by slot, so which of the two buttons the DM pressed
                // must not change what next week's load finds. Discarding the
                // *prep* is `ClearWalls`, which is a step on the ring; this
                // discards the slot.
                //
                // The plans go the other way and are gone — they are on the
                // tokens, not on the map. See *Two deliberate omissions* in
                // `docs/maps.md`.
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

            // Nothing is applied. `apply` is a misnomer for exactly one command
            // and this is it: there is no `&mut self` in the body, because a
            // ping changes nothing about the room. It goes through the pipeline
            // regardless rather than being short-circuited somewhere earlier,
            // because the four steps are where permission and delivery live and
            // a command with its own path around them is how one of the two gets
            // forgotten.
            // The one arm in this function that appends to a list nothing else
            // in the room reads. `check` has already decided the destination is
            // one this client may name, so all that is left is to write down who
            // said it — from the socket, never from the frame.
            ClientMsg::Say { to, text } => {
                let by = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // `check` proved this is a client. `Ping`'s fallback and the
                    // same reasoning: this decides whose name goes on it, and an
                    // unattributable line is one nobody sent.
                    None => return Vec::new(),
                };
                let line = ChatLine {
                    by,
                    to,
                    // Trimmed here as well as in `check`, because `check` only
                    // looked at a borrow — what goes in the log is what the room
                    // decided was sayable, not what arrived.
                    text: text.trim().to_owned(),
                };
                self.chat.push_back(line.clone());
                // From the front: the cap is a cap on how much of the evening is
                // still around, and the oldest of it is what nobody is looking
                // for any more.
                while self.chat.len() > MAX_CHAT_LINES {
                    self.chat.pop_front();
                }
                vec![Event::Said { line }]
            }

            // Whose box this is comes from the socket, exactly as a line of
            // talk's author does one arm up. Written whole rather than patched:
            // it is one string that changes when somebody stops typing.
            //
            // **Emptying it removes the entry rather than storing an empty
            // string**, which is `Override`'s `Auto` again — one representation
            // of "there is nothing here", so a cleared box costs the save file
            // nothing and a player who never opened this leaves no trace in it.
            ClientMsg::SetNotes { text } => {
                let owner = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // `check` proved this is a client. Same reasoning as the two
                    // arms around it: this decides whose box is being written,
                    // and a note nobody owns is one nobody can ever be sent.
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

            // The arm above with the private half taken out. Whose colour it is
            // still comes from the socket and never from the frame — but there
            // is no `by` on the event, because there is nobody to exclude: this
            // is one table everybody holds, so everybody is sent the same one.
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

            ClientMsg::Ping { at } => {
                let owner = match self.clients.get(&origin) {
                    Some(client) => drawn_by(client),
                    // Proved to be a client by `check`. `AddShape`'s fallback,
                    // and harmless here for a reason that one cannot claim —
                    // this decides a ring's colour rather than who may erase it.
                    None => Owner::Dm,
                };
                vec![Event::Pinged {
                    by: origin,
                    owner,
                    at,
                }]
            }

            // The arm above, and the only one in this function that takes
            // `&self` for nothing but a lookup twice over. **The room is not
            // touched**: no field is written, nothing is marked dirty, and the
            // event is the whole of what happened.
            //
            // The fallback is not harmless the way `Ping`'s is and cannot be
            // reached the way that one describes: an owner guessed as the DM
            // here would be a pointer that the fog filter then treats as the
            // DM's. `check` has already proved this is a client, so the arm
            // returns nothing rather than inventing a sender.
            ClientMsg::MoveCursor { at } => match self.clients.get(&origin) {
                Some(client) => vec![Event::CursorMoved {
                    by: origin,
                    owner: drawn_by(client),
                    at,
                }],
                None => Vec::new(),
            },

            // One run in, one segment per gap between its corners out. The run
            // itself is not stored — it was how the DM drew, not what the map
            // holds — which is what lets one bad segment of a long trace be
            // erased without redrawing the rest of it.
            ClientMsg::AddWalls {
                points,
                door,
                staged,
            } => {
                let kind = if door {
                    // Traced shut. A door the DM has to close after drawing it is
                    // a door they will forget to close, and a dungeon's doors are
                    // shut until somebody opens them. That holds on both boards:
                    // a staged door is traced shut too, and swinging it before
                    // the promote is how the DM says otherwise.
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
                        // The server's to invent, like a shape's or a token's.
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
            // the staged one it is authoring — whatever it is left as is what
            // promotes, which is how the DM prepares a room that is already ajar.
            ClientMsg::ToggleDoor { id, staged } => {
                for wall in self.walls_mut(staged).into_iter().flatten() {
                    if wall.id == id {
                        // Proved to be a door by `check`; masonry is left alone
                        // rather than turned into one.
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
                    // `Auto` is the absence of an entry rather than a fourth
                    // variant, so handing cells back to the rays is a removal.
                    // One representation of "not overridden", which is what keeps
                    // `recompute_sight` from having a case that does nothing.
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
                // The fog moving is `refresh_fog`'s to report, not this arm's.
                // It runs against a reading taken before `apply`, so whatever the
                // mask did to the two sets is already in the difference — and if
                // the DM painted `Dark` over cells nobody could see anyway, there
                // is correctly no `FogChanged` at all.
                //
                // Painting the staged board there is nothing for it to report at
                // all: `moves_sight` says so, and it is right — no ray has ever
                // been cast on a map the table has not been shown.
                vec![Event::OverridesChanged { staged }]
            }

            // The whole map back to dark, and then whatever the party can see
            // from where they are standing. `sweep_board` without the board: the
            // same three sets and the same mask, minus the shapes and the walls,
            // because this is the fog starting over and not the map.
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
                // `check` proved there is one, and the `if let` is what keeps
                // that proof from being a `expect` — a ring emptied between the
                // two would leave the room untouched rather than panic.
                self.undo.pop_back();
                let Some(back) = self.undo.back() else {
                    return Vec::new();
                };
                // Cloned rather than popped: the state being restored *is* the
                // new top of the ring, because the back of it is always where
                // the DM now stands. Taking it off would make the next undo skip
                // a step.
                let back = back.state.clone();
                // **The one thing a restore is told to leave alone**, and the
                // only exception `adopt` has ever needed. Milestone 22's rule is
                // that the ring may hold state the undoing hand wrote; every
                // scratchpad on that snapshot was written by somebody else, and
                // restoring one eats a paragraph its author cannot get back and
                // was never told about. `undid` keeps `SetNotes` from *being* a
                // step; this is the other half, because a note written between
                // two other commands is on the snapshot regardless of what put
                // it there.
                //
                // Taken and put back rather than filtered out of the snapshot at
                // push time: what belongs here is whatever people have typed
                // *since*, which is what the room is holding right now.
                //
                // **Two things now, and the second is why this is a rule rather
                // than a special case.** A colour is a player's the same way a
                // paragraph is, and neither is the DM's to take back — milestone
                // 27 is what turned "the only thing exempted by hand" into a
                // list. Both halves are still needed for each: `undid` keeps the
                // command from being a step, and this keeps a colour picked
                // between two other commands off the snapshot they pushed.
                let notes = std::mem::take(&mut self.notes);
                let colours = std::mem::take(&mut self.colours);
                self.adopt(back);
                self.notes = notes;
                self.colours = colours;
                // `adopt` empties both derived sets — a `Saved` holds the party's
                // memory and not their sight. Done here rather than through
                // `moves_sight` and `refresh_fog`, because `Restored` already
                // describes the whole board including its fog and the difference
                // those would report is a second copy of the same news.
                self.recompute_sight();
                vec![Event::Restored, Event::UndoChanged]
            }
        }
    }

    /// Everything about the fog that a command might change, read before it runs.
    fn sight_now(&self) -> Sight {
        Sight {
            fog: self.fog_for(),
            // Read off the record and pointedly not off the tokens: this has to
            // be what the table *holds*, and a drag frame has already moved the
            // one token that could disagree. See `RoomState::shown`.
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
                | Event::BackdropChanged
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
                // Neither can reach here: `moves_sight` is false for `Undo`, so
                // `refresh_fog` does not run on the command that produces them.
                // Listed rather than caught by a wildcard, because the whole
                // point of this match being exhaustive is that a later event
                // naming a token cannot be forgotten.
                | Event::Restored
                | Event::PresenceChanged
                | Event::ColoursChanged
                | Event::CursorsChanged
                | Event::UndoChanged => None,
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

    /// Files what was traced and painted on one image under that image's URL.
    ///
    /// **The shelf's only write.** Four paths reach it — a load into the live
    /// slot and a promote, both through `sweep_board`, and the two ways a staged
    /// board leaves its slot — and they hand over different boards, which is why
    /// the walls and the paint are arguments rather than read off `self`. The
    /// rule they share is that a board's authoring is filed whenever that board
    /// stops being held, so which of them the DM triggered cannot change what
    /// the shelf remembers.
    ///
    /// Whatever the board actually holds, including nothing: a DM who cleared
    /// the walls and then loaded away has cleared them, and filing only
    /// non-empty lists would make that unsayable.
    ///
    /// Nothing is filed about the blank map a fresh room starts on: `check`
    /// refuses an empty map URL, so that string names no map anyone could load
    /// back.
    ///
    /// The read is not here. `Prepared` is looked up in the one arm that loads a
    /// map, beside the calibration it has always looked up.
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
    /// is deliberately *not* reached by a recalibration: the drawings are cells
    /// on this board and the walls trace this art, and correcting the grid
    /// changes neither of those facts.
    ///
    /// **A promote clears with this and then puts the staged board's walls and
    /// paint in their place.** That is not this function's business — it clears,
    /// and its caller decides whether anything arrives — and keeping it that way
    /// is what lets a map load and a promote go on sharing it.
    ///
    /// Both halves are gated on being non-empty, and that is not tidiness. An
    /// unconditional `ShapesChanged` on every map load tells the table something
    /// happened to a board that had nothing on it — the same gate the initiative
    /// panel uses, for the third time. `WallsChanged` reaches the DM alone, who
    /// is the one doing this, so the gate there is merely honest.
    ///
    /// **The outgoing map's URL is passed in rather than read off `self.map`,
    /// and that is not a style choice.** The two call sites order the map
    /// assignment opposite ways round — a `SetMap` assigns and then sweeps,
    /// while a promote sweeps and then assigns — so `self.map.url` in here is
    /// the *incoming* map on one path and the outgoing one on the other. Filing
    /// a dungeon's masonry under the name of the map that replaced it puts the
    /// walls back on the wrong image, and nothing about it looks wrong until
    /// the DM loads away and back.
    fn sweep_board(&mut self, outgoing: &str) -> Vec<Event> {
        // Onto the shelf before any of it is cleared. What follows is the same
        // destruction it always was; what changed in milestone 31 is that the
        // map keeps a copy of what was on it, so loading away is no longer
        // half an hour of tracing gone.
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
        // Half an hour of tracing, gone with one map load and no undo. That is
        // the same bargain the drawings make and the roadmap asks for — walls
        // are grid- and art-specific, and a wall traced on the last dungeon is
        // a line across the middle of this one.
        if !self.walls.is_empty() {
            self.walls.clear();
            events.push(Event::WallsChanged { staged: false });
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
            events.push(Event::OverridesChanged { staged: false });
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
            //
            // Through `remove_client` and not a bare `clients.remove`, which is
            // what this was. The socket closing does raise `Disconnected`, but
            // that arm is guarded on the entry still being there — so removing
            // it here used to mean the guard was false when the news arrived and
            // every departure step was skipped in silence.
            warn!(?client, "outbound mailbox full, dropping client");
            self.remove_client(client);
        }
    }

    /// The one way a client leaves, whether it hung up or wedged.
    ///
    /// **Two callers and they used to disagree.** `Disconnected` did all of this;
    /// `dispatch` dropped a wedged client with a bare `clients.remove` and left
    /// the room believing they were still here — the presence strip still named
    /// them, their roster slot still read as taken to anyone sitting on the
    /// picker, and a sketch they were part way through stayed on every other
    /// screen. Not a leak, but three things the table can see and nothing to
    /// explain them.
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
        // unconditionally, because "was that client sketching" is state the room
        // would have to keep to answer and an id nobody is drawing is a no-op on
        // arrival.
        //
        // This is what a movement ruler cannot have: nothing tells the room a
        // drag stopped, so that one guesses with a timeout. Here the socket
        // closing *is* the news. The socket is already out of `clients`, so
        // neither of these reaches it and `here` no longer counts it.
        self.dispatch(
            client,
            &[Event::SketchEnded { by: client }, Event::PresenceChanged],
        );
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

            // And a third time. This is the one of the three whose frame changes
            // what the recipient *sends* rather than only what it draws, which
            // is why nobody may be left out of it: a client still holding `true`
            // after the switch went off would go on shipping its pointer into a
            // room that drops every frame.
            Event::CursorsChanged => Some(ServerMsg::CursorsChanged {
                show: self.show_cursors,
            }),

            // And a fourth time, unfiltered like the three above it. What makes
            // this one worth its own note is what is *not* beside it: covering
            // the board changes no map, no wall, no shape and no cell of fog, so
            // this frame travels alone and every recipient still holds the board
            // it had.
            Event::BackdropChanged => Some(ServerMsg::BackdropChanged {
                url: self.backdrop.clone(),
            }),

            // The filter doing its actual job. Every arm above drops a message
            // for something the recipient *did*; this one drops it for who the
            // recipient is, which is the shape hidden tokens and fog need. A
            // player is not sent a staged map and told not to draw it — the
            // frame does not exist for them at all.
            //
            // It carries the whole staged board rather than only its map, which
            // is what lets a staged load sweeping its walls and a staged
            // recalibration dropping its paint need no frames of their own.
            Event::StagedChanged => self.is_dm(recipient).then(|| ServerMsg::StagedChanged {
                board: self.staged.as_ref().map(StagedBoard::view),
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

            // The sketch rule for the third time — the pinger is drawing their
            // own ring already — and then it stops resembling anything else in
            // this function. **Every other arm here either builds something per
            // recipient or drops the message for somebody**; this one does
            // neither past the echo. There is no `is_dm`, no `unseen_by_table`,
            // no `in_sight`, and that is the decision rather than an omission: a
            // ping is relayed wherever it lands, including onto ground the party
            // has never explored.
            //
            // It is safe because there is nothing in it to read. A ring over
            // black says the DM is gesturing in a direction, not what is
            // standing there — and the DM can see their own fog while they hold
            // the button, so they know what they are pointing over. The
            // alternative is a deliberate 400ms gesture that sometimes silently
            // does nothing, which is worse than useless: a gesture you cannot
            // tell has failed is one you stop trusting.
            Event::Pinged { by, owner, at } => (recipient != *by).then(|| ServerMsg::Pinged {
                by: owner.clone(),
                at: *at,
            }),

            // **The arm above with the paragraph above reversed**, and the two
            // are worth reading together because the difference between them is
            // the whole design of both. A ping is a deliberate 400ms gesture and
            // a ring over black says only that somebody is pointing in a
            // direction; a cursor is nobody's decision, and the DM's drifts
            // wherever the DM is working. So this one asks `cursor_seen`, which
            // is no filter at all for three of its four cases and the fog for
            // the fourth.
            //
            // The room's switch is read here rather than in `check`, which is
            // what makes it a dial on the traffic rather than a preference: with
            // it off, not one of these leaves the room. The mover is skipped for
            // `Pinged`'s reason — their own pointer is drawn by their own
            // operating system, and drawing a second one a round trip behind it
            // is the rubber-band a token drag already refuses.
            Event::CursorMoved { by, owner, at } => (recipient != *by
                && self.show_cursors
                && self.cursor_seen(owner, *at, self.is_dm(recipient)))
            .then(|| ServerMsg::CursorMoved {
                by: owner.clone(),
                at: *at,
            }),

            // **The first frame in this function withheld from one player and
            // sent to another.** Every filtered arm above draws its line between
            // the DM and the table; this one draws it between two people at the
            // same table, and the question it asks is not `is_dm` at all.
            //
            // The sender is sent their own, which no other relayed frame here
            // does — see `ServerMsg::Said`. Nothing about a line of text is
            // predicted on the client, because where it lands in the log is the
            // room's to decide.
            Event::Said { line } => {
                let identity = &self.clients.get(&recipient)?.identity;
                party_to(identity, line).then(|| ServerMsg::Said { line: line.clone() })
            }

            // **The narrowest audience in this function, and the first the DM
            // is not automatically in.** One person is party to a scratchpad —
            // its author — so this asks whose it is and stops. The `is_dm` that
            // every filter above eventually reaches for would, here, be the
            // thing that broke it.
            //
            // Minus the socket that typed it, which is `Pinged`'s exclusion
            // rather than `Said`'s: the text is already in that box, and writing
            // it back a round trip later moves the caret mid-sentence. The
            // author's *second tab* is what is left, and is the whole audience
            // this event has.
            Event::NotesChanged { by, owner, text } => {
                let identity = &self.clients.get(&recipient)?.identity;
                (recipient != *by && is_owner(identity, owner))
                    .then(|| ServerMsg::NotesChanged { text: text.clone() })
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
            //
            // Staging changed nothing here, which is the reason this was the
            // cheapest subsystem in the project to stage: there was no filter to
            // widen because there was never a filtered form. A staged wall is
            // withheld by the line that already withheld a live one.
            Event::WallsChanged { staged } => {
                self.is_dm(recipient).then(|| ServerMsg::WallsChanged {
                    walls: self.walls_in(*staged).to_vec(),
                    staged: *staged,
                })
            }

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
            Event::OverridesChanged { staged } => {
                self.is_dm(recipient).then(|| ServerMsg::OverridesChanged {
                    overrides: self.overrides_for(*staged),
                    staged: *staged,
                })
            }

            // **Everyone, and through `snapshot_for`** — which is invariant 3
            // doing exactly its job on the second message that hands over the
            // whole world. Filtering every delta correctly and then sending an
            // unfiltered snapshot is the most common way this project could
            // leak, and an undo is a snapshot; routing it through the same
            // function a join uses is what means there is no second filter to
            // keep in step.
            //
            // A player is sent one too, and has to be: the room they are looking
            // at just changed underneath them, and the DM's walls and staged map
            // leave through the same door here as on any join.
            Event::Restored => {
                let identity = self.clients.get(&recipient)?.identity.clone();
                Some(ServerMsg::Restored {
                    state: Box::new(self.snapshot_for(&identity)),
                })
            }

            // The walls' rule for the fourth time, and the mildest instance of
            // it: what is withheld is not a secret but a label for a button a
            // player does not have.
            Event::UndoChanged => self.is_dm(recipient).then(|| ServerMsg::UndoChanged {
                label: self.undo_label(),
            }),

            // And the two arms with no rule in them at all, which is the shape
            // `NamesChanged` and `FogChanged` already have: one list, read off
            // `&self`, identical for every recipient including whoever caused
            // it. There is nothing here to filter — a table that cannot tell
            // whether the DM is still connected is the problem the first one
            // exists to solve, and a colour nobody else can see is not a colour.
            Event::PresenceChanged => Some(ServerMsg::Presence { here: self.here() }),
            Event::ColoursChanged => Some(ServerMsg::ColoursChanged {
                colours: self.colours.clone(),
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

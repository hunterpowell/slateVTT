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

use crate::protocol::{
    Calibration, ClientId, ClientMsg, Initiative, InitiativeEntry, MapInfo, Owner, PlayerId,
    RoomView, RosterEntry, RosterSlot, ServerMsg, Token, TokenId,
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
    },
    /// Carries no payload on purpose: `message_for` has `&self` and builds the
    /// panel per recipient. That is the seam where fog of war will one day hide
    /// an unseen monster's row from the players.
    InitiativeChanged,
    /// A new image, a recalibrated grid, or both. Payload-free for the same
    /// reason as above — terrain is exactly what fog of war filters first.
    MapChanged,
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
    tokens: HashMap<TokenId, Token>,
    initiative: Initiative,
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
        Event::TokenMoved { dragging, .. } => !dragging,
        Event::InitiativeChanged | Event::MapChanged => true,
    }
}

fn require_dm(client: &Client) -> Result<(), String> {
    match client.identity {
        Identity::Dm => Ok(()),
        Identity::Player(_) => Err("only the DM can change initiative".to_owned()),
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

/// The permission rule for movement. Token creation and deletion are DM-only
/// too, but those commands do not exist yet.
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
            tokens: saved
                .tokens
                .into_iter()
                .map(|t| (t.id.clone(), t))
                .collect(),
            initiative: saved.initiative,
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
            tokens,
            initiative: self.initiative.clone(),
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
                    };
                    (id, token)
                })
                .collect(),
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

        let events = self.apply(msg);
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
            state: self.snapshot_for(&identity),
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

    fn snapshot_for(&self, _identity: &Identity) -> RoomView {
        let mut tokens: Vec<Token> = self.tokens.values().cloned().collect();
        // `HashMap` iteration order varies per process, and the client treats
        // list order as z-order. Without this, two tabs can disagree about
        // which of two overlapping tokens is on top.
        tokens.sort_by(|a, b| a.id.cmp(&b.id));
        RoomView {
            map: self.map.clone(),
            tokens,
            initiative: self.initiative.clone(),
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
            ClientMsg::MoveToken { id, x, y, .. } => {
                let Some(token) = self.tokens.get(id) else {
                    return Err(format!("no such token: {}", id.0));
                };
                if !can_move(client, token) {
                    return Err(format!("{} is not yours to move", token.name));
                }
                finite(&[*x, *y])
            }

            ClientMsg::SetMap {
                url,
                grid_px,
                offset_x,
                offset_y,
                grid_color,
                play_area,
            } => {
                require_dm(client)?;
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

            ClientMsg::SetInitiative { token, .. } => {
                require_dm(client)?;
                if self.tokens.contains_key(token) {
                    Ok(())
                } else {
                    Err(format!("no such token: {}", token.0))
                }
            }

            ClientMsg::RemoveFromInitiative { .. }
            | ClientMsg::ClearInitiative
            | ClientMsg::NextTurn
            | ClientMsg::PreviousTurn => require_dm(client),
        }
    }

    /// Step 3. Mutates state, returns what happened.
    fn apply(&mut self, msg: ClientMsg) -> Vec<Event> {
        match msg {
            ClientMsg::Hello { .. } => Vec::new(),
            ClientMsg::MoveToken { id, x, y, dragging } => {
                let Some(token) = self.tokens.get_mut(&id) else {
                    // `check` already proved this exists; belt and braces so a
                    // future reordering of the pipeline cannot panic here.
                    return Vec::new();
                };

                // In-flight drag frames stay wherever the pointer is so motion
                // reads as smooth. The drop is what settles onto the grid.
                let (x, y) = if dragging { (x, y) } else { snap_to_cell(x, y) };
                token.x = x;
                token.y = y;

                vec![Event::TokenMoved { id, x, y, dragging }]
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
            } => {
                let given = Calibration {
                    grid_px,
                    offset_x,
                    offset_y,
                    grid_color,
                    play_area,
                };

                // The URL alone says which of the two things this is. A URL the
                // room is not already showing is a map being loaded, so anything
                // remembered for it wins over what the client sent — which is
                // how re-picking a map comes back calibrated without the client
                // knowing the table exists. A URL that matches the current map
                // is the DM recalibrating it, which is applied as given.
                //
                // Recording only in the second case, and on a load of a map with
                // nothing remembered yet, is what keeps the two halves from
                // cancelling: if a load recorded too, a remembered calibration
                // would immediately overwrite itself with the client's guess.
                let loading = url != self.map.url;
                let calibration = match self.calibrations.get(&url) {
                    Some(remembered) if loading => remembered.clone(),
                    _ => {
                        self.calibrations.insert(url.clone(), given.clone());
                        given
                    }
                };

                self.map = calibration.into_map(url);
                vec![Event::MapChanged]
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
            Event::TokenMoved { id, x, y, dragging } => {
                // The originator is already drawing this from its own local
                // prediction; echoing mid-drag frames back rubber-bands it. The
                // drop frame is echoed, because it carries the server's snap and
                // is the only way the originator learns its settled position.
                if *dragging && recipient == origin {
                    return None;
                }
                Some(ServerMsg::TokenMoved {
                    id: id.clone(),
                    x: *x,
                    y: *y,
                    dragging: *dragging,
                })
            }

            // Built per recipient rather than carried on the event, so a future
            // filter can drop rows this client is not allowed to see.
            Event::InitiativeChanged => Some(ServerMsg::InitiativeChanged {
                initiative: self.initiative.clone(),
            }),

            // Echoed to the DM who sent it as well. Unlike a token drag there is
            // no local prediction to rubber-band: the client draws the grid the
            // server confirmed, so this frame is how the DM sees the result.
            Event::MapChanged => Some(ServerMsg::MapChanged {
                map: self.map.clone(),
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

/// Nearest cell centre, in grid units. A token in cell (0,0) is stored at
/// (0.5, 0.5), which keeps an even-sized token centred on a cell corner.
///
/// This rule lives only here. The client never snaps; it learns the settled
/// position from the echoed drop frame.
fn snap_to_cell(x: f32, y: f32) -> (f32, f32) {
    (x.floor() + 0.5, y.floor() + 0.5)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the tests name this type; `check` and `apply` reach it through the
    // `Option` on the message.
    use crate::protocol::Rect;

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
                        dragging: false
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

        let events = state.apply(ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: 6.83,
            y: 5.21,
            dragging: true,
        });
        assert!(
            matches!(events.as_slice(), [Event::TokenMoved { x, y, .. }] if *x == 6.83 && *y == 5.21)
        );

        let events = state.apply(ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: 6.83,
            y: 5.21,
            dragging: false,
        });
        assert!(
            matches!(events.as_slice(), [Event::TokenMoved { x, y, .. }] if *x == 6.5 && *y == 5.5)
        );

        let token = state.tokens.get(&TokenId::new("t1")).expect("t1 exists");
        assert_eq!((token.x, token.y), (6.5, 5.5));
    }

    #[test]
    fn snapping_is_stable_under_repeated_drops() {
        let (x, y) = snap_to_cell(6.5, 5.5);
        assert_eq!((x, y), (6.5, 5.5));
        assert_eq!(snap_to_cell(x, y), (6.5, 5.5));
    }

    #[test]
    fn snapping_handles_negative_coordinates() {
        // `round`-based snapping would send -0.2 to cell 0; the token belongs in
        // cell -1. Off-map drags are legal and must not fold onto the map.
        assert_eq!(snap_to_cell(-0.2, -1.7), (-0.5, -1.5));
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
        };
        assert!(state.message_for(me, me, &drag).is_none());
        assert!(state.message_for(them, me, &drag).is_some());

        let drop = Event::TokenMoved {
            id: TokenId::new("t1"),
            x: 1.5,
            y: 1.5,
            dragging: false,
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
        };
        assert!(state.check(ClientId(1), &msg).is_err());
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
        let raw = r#"{"type":"move_token","id":"t1","x":1e39,"y":0.0,"dragging":false}"#;
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

mod fog;
mod library;
mod protocol;
mod room;
mod store;
mod ws;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::Request;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::fs;
use tower_http::services::ServeDir;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::protocol::ClientId;
use crate::room::{RoomHandle, RoomStatus};

/// Big enough for a detailed battle map, small enough that a mistyped upload
/// cannot fill the disk. axum's own default is 2 MB, which most maps exceed.
const MAX_MAP_BYTES: usize = 25 * 1024 * 1024;
/// Token art is drawn inside a circle a cell wide. Anything approaching this is
/// already far more image than the board can show.
const MAX_TOKEN_BYTES: usize = 4 * 1024 * 1024;
/// Background music the table hears for an hour. Bounded well under the map cap
/// because `copy_out` reads a whole file into memory and the box this runs on
/// has a gigabyte of it, and because seven browsers fetch a track. They only
/// fetch it once each: `/uploads` is `immutable` and a copy's name is a
/// fingerprint of its bytes.
const MAX_TRACK_BYTES: usize = 16 * 1024 * 1024;
/// Protocol frames are tiny JSON commands. Keeping this bounded prevents a
/// public WebSocket from using one frame to reserve an unreasonable buffer.
///
/// **Inbound only.** `max_message_size` and `max_frame_size` gate tungstenite's
/// *read* path, so nothing here bounds a `Welcome` on its way out. It does
/// bound every command, and one of them carries a variable-length collection:
/// `SetFogOverride` names its cells one pair at a time. `MAX_OVERRIDE_CELLS` is
/// set against this number, and a test in `room::tests::fog_of_war` serialises
/// the largest legal one and asserts it fits (see `docs/net.md`). A cap below a
/// legitimate room fill drops the DM's socket instead of refusing the command.
///
/// The cost of the larger number is that a socket which has not said who it is
/// yet may push this much. That's acceptable behind a tunnel with a DM secret.
pub(crate) const MAX_WS_MESSAGE_BYTES: usize = 128 * 1024;
const DM_SECRET_HEADER: &str = "x-slate-dm-secret";
/// Read by `/api/status` only, and never a substitute for the DM secret. A
/// display on the wall holds this one and nothing else. See
/// `client/status/README.md`.
const STATUS_KEY_HEADER: &str = "x-slate-status-key";
/// How long `/api/status` waits on one room before calling it unresponsive.
///
/// **Bounded because a wedged room actor never drains its mailbox**, and an
/// unbounded wait would hang the status page when it is the only thing that
/// could tell you why. Generous next to a healthy room, which answers in
/// microseconds.
const STATUS_TIMEOUT: Duration = Duration::from_secs(2);
/// What `/api/status` calls wrong. **Decided here, once**, because the page has
/// two renderers (`status.js` in a browser and `kindle.py` drawing a PNG) and
/// two copies of a threshold drift. Both show what `verdict` says and judge
/// nothing themselves.
///
/// The collector runs every minute, so five minutes allows four misses. A
/// status page that raises false alarms gets ignored.
const HOST_STALE_S: u64 = 300;
const CPU_HOT_C: f64 = 75.0;
const DISK_FULL_PCT: f64 = 90.0;

/// Every room's handle, keyed by the id in `room::ROOMS`.
///
/// **No lock.** The rooms are known before the first socket opens, so this map
/// is built once in `main` and only read after that. Don't add an `RwLock`: a
/// lock guards a table that changes, and nothing changes this one. It would
/// only be needed for rooms the DM could create at runtime, which aren't
/// wanted.
///
/// Read on connect only, and never on a token move: a socket resolves its room
/// once in `ws_handler` and then talks to that actor's `mpsc` directly.
#[derive(Clone)]
struct AppState {
    rooms: Arc<HashMap<String, RoomHandle>>,
    /// Which rooms this process serves: `SLATE_SITE`, or `room::DEFAULT_SITE`.
    /// The picker and the status page list this site's rooms and no other's.
    site: Arc<str>,
    /// The room holds its own copy for the WebSocket handshake. This one exists
    /// because an HTTP upload never reaches the room actor to be checked there.
    dm_secret: Arc<str>,
    uploads: Arc<Path>,
    /// The four libraries the DM picks from. None is served directly: a pick
    /// copies into `uploads`, so there is one kind of image URL.
    maps: Arc<Path>,
    portraits: Arc<Path>,
    backdrops: Arc<Path>,
    /// The one library that isn't pictures, and the reason `library::Formats`
    /// exists: the three above are sniffed against `IMAGES` and this one
    /// against `AUDIO`. See `docs/sound.md`.
    tracks: Arc<Path>,
    /// The status page's own credential. When `None`, `/api/status` is **not
    /// mounted at all**, which is why this is read before the router is built.
    /// It isn't the DM secret because it grants nothing but this one read-only
    /// JSON.
    status_key: Option<Arc<str>>,
    /// A file some *other* process on the box writes with the host's vitals,
    /// passed through verbatim. The server stays platform-independent (it never
    /// reads `/sys/class/thermal`), and on a machine with no collector the
    /// section reads `null`.
    host_status: Option<Arc<Path>>,
    /// The same, for what the deploy stamped. Read once at boot because unlike
    /// the host's vitals it can't change while the process runs.
    build: Option<Value>,
    /// For `uptime_s`, and its wall-clock counterpart for `started_unix`. An
    /// `Instant` can't be formatted and a `SystemTime` jumps when the clock is
    /// set, so the status needs both.
    started_at: Instant,
    started_unix: u64,
}

/// Which folder a listing or a pick is about.
///
/// Every library does the same operation (prove some bytes are the right kind
/// of file, give them a name of ours, report the URL) against a different
/// directory and size cap. This enum tells them apart, so there is one copy of
/// the path handling that `library.rs` guards, not one per library.
#[derive(Clone, Copy)]
enum Library {
    Maps,
    Portraits,
    /// Pictures shown *instead of* the board, with no grid and nothing standing
    /// on them. A separate folder from `maps/` because the map picker lists
    /// things to play on, and mixing in pictures you can't play on makes both
    /// lists worse.
    Backdrops,
    /// The music the room plays. A separate folder for the same reason, and
    /// nothing in it is a picture, so each library says what it may hold
    /// (`formats`).
    Tracks,
}

impl Library {
    /// The folder named by the `{library}` segment of an `/api` path, which is
    /// also the plural the client's `createLibraryList` is built around.
    fn named(segment: &str) -> Option<Self> {
        match segment {
            "maps" => Some(Self::Maps),
            "portraits" => Some(Self::Portraits),
            "backdrops" => Some(Self::Backdrops),
            // **This plural and no other.** `client/src/library.ts` derives the
            // noun it puts in a refusal by dropping the last letter of the
            // segment, so this must be `noun` below plus an "s".
            "tracks" => Some(Self::Tracks),
            _ => None,
        }
    }

    fn dir(self, state: &AppState) -> Arc<Path> {
        match self {
            Self::Maps => state.maps.clone(),
            Self::Portraits => state.portraits.clone(),
            Self::Backdrops => state.backdrops.clone(),
            Self::Tracks => state.tracks.clone(),
        }
    }

    /// Named in the refusals, so a DM reading one knows which list it is about.
    fn noun(self) -> &'static str {
        match self {
            Self::Maps => "map",
            Self::Portraits => "portrait",
            Self::Backdrops => "backdrop",
            Self::Tracks => "track",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Maps => MAX_MAP_BYTES,
            Self::Portraits => MAX_TOKEN_BYTES,
            // A map's cap: a backdrop fills the whole window, so it is the
            // same kind of picture as a battle map with the grid left off.
            Self::Backdrops => MAX_MAP_BYTES,
            // Sixteen mebibytes is around seventeen minutes at 128 kbps and
            // about ninety seconds of uncompressed WAV. Refusing the WAV is
            // intended: a DM who drops a five-minute WAV in gets one clear
            // error instead of a Pi reading fifty megabytes into a gigabyte
            // of RAM.
            Self::Tracks => MAX_TRACK_BYTES,
        }
    }

    /// Prepended to the key the copy's name is derived from, so `cave.png` in
    /// two libraries doesn't resolve to one file. Otherwise the second pick
    /// would find the first already there, skip the write, and hand back a map
    /// as somebody's portrait.
    ///
    /// **Maps keep the empty prefix.** The remembered calibration table is
    /// keyed on the URL their names produce, so adding one would orphan every
    /// map the DM has ever calibrated.
    fn prefix(self) -> &'static str {
        match self {
            Self::Maps => "",
            Self::Portraits => "portrait/",
            Self::Backdrops => "backdrop/",
            Self::Tracks => "track/",
        }
    }

    /// Whether a copy is named from the bytes it holds or from the path it
    /// came from. Like `prefix`, what feeds the name decides what a re-pick
    /// resolves to.
    ///
    /// **Portraits are named from their contents** so that replacing the art in
    /// the folder replaces it on the token. Named from the path, the copy is
    /// written once and every later pick finds it already there and skips the
    /// write: the DM swaps a portrait, re-picks it, builds a new token, and
    /// gets the old image every time with nothing to say why.
    ///
    /// Maps are named from their path and must stay that way. The remembered
    /// calibration table is keyed on the URL these names produce, so naming a
    /// map by its contents would orphan every map the DM has ever calibrated,
    /// the same trap as giving maps a prefix. The cost is that replacing a
    /// map's art in `maps/` does nothing. That asymmetry with uploads is
    /// described in `docs/maps.md`, and closing it means migrating the
    /// calibration table, not changing this.
    fn names_by_content(self) -> bool {
        match self {
            Self::Maps => false,
            Self::Portraits => true,
            // As for portraits, and the maps' objection doesn't apply: nothing
            // is keyed on a backdrop's URL (the room holds one, and replacing
            // a stale one is what a re-pick is for), so replacing the art in
            // the folder should replace the picture the table is looking at.
            Self::Backdrops => true,
            // As for backdrops: nothing is keyed on a track's URL, so
            // re-encoding a loop in the folder and re-picking it should hand
            // back the new bytes.
            Self::Tracks => true,
        }
    }

    /// What this library will list, accept and refuse.
    ///
    /// The three picture libraries share one arm, so adding the track library
    /// visibly changed nothing about the other three. See `library::Formats`.
    fn formats(self) -> &'static library::Formats {
        match self {
            Self::Maps | Self::Portraits | Self::Backdrops => &library::IMAGES,
            Self::Tracks => &library::AUDIO,
        }
    }
}

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

/// The client may reuse nothing without asking.
///
/// **`index.html` and `dist/main.js` are fixed names with no content hash in
/// them**, so a browser or a proxy holding an old copy serves an old Slate
/// against a new server, with nothing on screen to say so. Behind a Cloudflare
/// Tunnel this happens: with no `Cache-Control` at all, an intermediary is free
/// to choose its own freshness, and a shipped fix can stay invisible for as
/// long as it likes.
///
/// `no-cache` means *revalidate*, not *do not store*: the bundle is 82 KB and
/// the answer to an unchanged file is a 304 with no body. The cost is one round
/// trip per file per load, and in return a deploy is live the moment somebody
/// reloads.
async fn always_revalidate(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-cache"),
    );
    res
}

/// The opposite, for uploads.
///
/// An upload's name is fingerprinted by content (`the-field-551e4c12.png`), so
/// the bytes behind a URL here never change; a new picture is a new name. That
/// is the condition `immutable` describes, and it is why `always_revalidate`
/// would be wrong here: map art is megabytes, and revalidating every image on
/// every load is a round trip per token portrait, over a tunnel, for an answer
/// that is always 304.
async fn cache_forever(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    // **Only on a success.** A 404 carrying `immutable` is cached just as a
    // 200 is, so a portrait requested a moment before it exists would stay
    // missing on that screen for a year, or until the browser's data is
    // cleared.
    if res.status().is_success() {
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    res
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("slate_server=debug,tower_http=warn")),
        )
        .init();

    let addr = std::env::var("SLATE_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let client_dir = std::env::var("SLATE_CLIENT_DIR").unwrap_or_else(|_| "../client".to_owned());

    // Kept out of the source tree so it never lands in git. Unset means a fresh
    // random secret per boot, logged once. That's fine for a session, but set
    // it in the environment if you want the DM link to survive a restart.
    let dm_secret = std::env::var("SLATE_DM_SECRET").unwrap_or_else(|_| {
        let generated = Uuid::new_v4().simple().to_string();
        info!("SLATE_DM_SECRET unset — generated one for this run");
        generated
    });

    // No room in it: the DM picks one on the screen the same way a player does,
    // and a link that named a room would go stale the moment they wanted the
    // other one. `?room=` is honoured if you want to skip the picker.
    info!("DM link: http://{addr}/?dm={dm_secret}");

    let state_path = std::env::var("SLATE_STATE").unwrap_or_else(|_| "slate-state.json".to_owned());

    // A second site is a second process with its own secret and its own data,
    // for a DM who mustn't reach this one's rooms. See `RoomDef::site`. Refusing
    // to boot on a name with no rooms is the safe answer: a typo would
    // otherwise start a server with an empty picker, or, if the fallback were
    // the default site, serve somebody else's rooms under this process's secret.
    let site = std::env::var("SLATE_SITE").unwrap_or_else(|_| room::DEFAULT_SITE.to_owned());
    if room::rooms(&site).next().is_none() {
        panic!("SLATE_SITE={site} names no rooms; see `ROOMS` in server/src/room.rs");
    }
    info!(%site, "serving this site's rooms");

    let uploads_dir = std::env::var("SLATE_UPLOADS").unwrap_or_else(|_| "uploads".to_owned());
    std::fs::create_dir_all(&uploads_dir)
        .unwrap_or_else(|err| panic!("could not create {uploads_dir}: {err}"));

    // Not created if absent. They hold files someone put there by hand, so an
    // empty one created at boot would hide a mistyped SLATE_MAPS,
    // SLATE_PORTRAITS, SLATE_BACKDROPS or SLATE_TRACKS behind a picker that
    // just looks empty.
    let maps_dir = std::env::var("SLATE_MAPS").unwrap_or_else(|_| "../maps".to_owned());
    if !Path::new(&maps_dir).is_dir() {
        warn!(%maps_dir, "no map library there; the DM can still upload maps");
    }

    let portraits_dir =
        std::env::var("SLATE_PORTRAITS").unwrap_or_else(|_| "../portraits".to_owned());
    if !Path::new(&portraits_dir).is_dir() {
        warn!(%portraits_dir, "no portrait library there; the DM can still upload token art");
    }

    let backdrops_dir =
        std::env::var("SLATE_BACKDROPS").unwrap_or_else(|_| "../backdrops".to_owned());
    if !Path::new(&backdrops_dir).is_dir() {
        warn!(%backdrops_dir, "no backdrop library there; the DM can show the board instead");
    }

    let tracks_dir = std::env::var("SLATE_TRACKS").unwrap_or_else(|_| "../tracks".to_owned());
    if !Path::new(&tracks_dir).is_dir() {
        warn!(%tracks_dir, "no track library there; the room plays in silence");
    }

    // Unset means the status page does not exist on this server: the route is
    // never mounted, so an unguarded status surface cannot appear by accident
    // on a dev box. Empty is treated as unset for the same reason: an env file
    // with `SLATE_STATUS_KEY=` in it means someone wanted it off.
    let status_key = std::env::var("SLATE_STATUS_KEY")
        .ok()
        .filter(|key| !key.is_empty());
    let serve_status = status_key.is_some();
    if serve_status {
        info!("status page enabled at /status/");
    }

    // Written by something else on the box (a timer on the Pi) and passed
    // through untouched. See `client/status/README.md`.
    let host_status = std::env::var("SLATE_HOST_STATUS")
        .ok()
        .filter(|path| !path.is_empty());

    // The same for what the deploy stamped, read once because it can't change
    // while this process is alive. A missing or broken file is a warning and a
    // `null` section, never a failure to boot: nothing depends on it, and a
    // build stamp isn't a reason to refuse to start the game server.
    let build = match std::env::var("SLATE_BUILD_INFO")
        .ok()
        .filter(|p| !p.is_empty())
    {
        Some(path) => match fs::read_to_string(&path).await {
            Ok(text) => match parse_foreign_json(&text) {
                Ok(value) => Some(value),
                Err(err) => {
                    warn!(%path, %err, "SLATE_BUILD_INFO is not valid JSON; ignoring it");
                    None
                }
            },
            Err(err) => {
                warn!(%path, %err, "could not read SLATE_BUILD_INFO; ignoring it");
                None
            }
        },
        None => None,
    };

    let mut rooms = HashMap::new();
    for (id, name) in room::rooms(&site) {
        let path = save_path(&state_path, id);
        let store = store::Store::new(path.clone());

        // Startup, so a panic is allowed here, and refusing to boot is the safe
        // answer. Starting a fresh room on top of a save we couldn't read would
        // destroy the group's game with the first token move. One unreadable
        // room stops the whole process instead of the others carrying on
        // without it: a server that is *partly* up is one the DM finds out
        // about mid-session.
        let saved = store
            .load()
            .await
            .unwrap_or_else(|err| panic!("could not load {}: {err}", path.display()));

        let demo = room::boots_demo(id);
        match (&saved, demo) {
            (Some(_), _) => info!(%id, path = %path.display(), "restored a room from disk"),
            (None, true) => info!(%id, "no save found; starting from the built-in room"),
            (None, false) => info!(%id, "no save found; starting an empty room"),
        }

        // `ROOMS` is a const and its ids are unique (there is a test for it),
        // so this can't silently drop a room.
        let roster =
            room::roster_of(id).unwrap_or_else(|| panic!("{id} is in ROOMS but has no roster"));
        info!(%id, %name, slots = roster.len(), "room ready");
        rooms.insert(
            id.to_owned(),
            room::spawn(dm_secret.clone(), roster, saved, store, demo),
        );
    }
    let rooms = Arc::new(rooms);

    let state = AppState {
        rooms: rooms.clone(),
        site: site.into(),
        dm_secret: dm_secret.into(),
        uploads: Path::new(&uploads_dir).into(),
        maps: Path::new(&maps_dir).into(),
        portraits: Path::new(&portraits_dir).into(),
        backdrops: Path::new(&backdrops_dir).into(),
        tracks: Path::new(&tracks_dir).into(),
        status_key: status_key.map(Arc::from),
        host_status: host_status.map(|path| Path::new(&path).into()),
        build,
        started_at: Instant::now(),
        // A clock that has never been set reads as the epoch rather than
        // failing; the page shows what it is given.
        started_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        // **The one route under `/api` that isn't the DM's.** The room picker
        // is built from it, and a player has no credential to offer. It
        // discloses the room names, which aren't secret the way the map
        // library is: a name on a picker, against a list of every dungeon the
        // DM has prepared. The unguessable subdomain is the access control
        // here, as everywhere else in this project.
        //
        // Static segments outrank `{library}` in axum's router, and
        // `Library::named("rooms")` is `None` anyway, so either guard alone
        // would do. There is a test for the second.
        .route("/api/rooms", get(room_listing))
        // Four libraries and four things to do to each, so the folder is a
        // path segment resolved by `Library::named`, not sixteen routes. An
        // unknown segment is a 404, not the client fallback.
        //
        // There is no separate upload route. Adding an image *is* putting it
        // in the library: `add` ends by picking the file it just wrote, so an
        // upload and a pick answer with the same URL for the same bytes.
        .route("/api/{library}", get(listing))
        .route("/api/{library}/pick", post(pick))
        // The body limit is the largest any library allows, because one route
        // serves them all. The per-library cap is checked inside the handler,
        // where it can be refused with a sentence instead of a dropped
        // connection.
        .route(
            "/api/{library}/add",
            post(add).layer(DefaultBodyLimit::max(MAX_MAP_BYTES)),
        )
        .route("/api/{library}/remove", post(remove))
        .nest_service(
            "/uploads",
            Router::new()
                .fallback_service(ServeDir::new(&uploads_dir))
                .layer(middleware::from_fn(cache_forever)),
        )
        .fallback_service(
            Router::new()
                .fallback_service(ServeDir::new(&client_dir).append_index_html_on_directories(true))
                .layer(middleware::from_fn(always_revalidate)),
        );

    // **Mounted only when there is a key**, so "no key" is a 404, not a 403:
    // an endpoint that answers "wrong credential" has announced it exists. It
    // also keeps `/api/rooms` the only route under `/api` a client can reach
    // without a credential.
    //
    // Static `/api/status` outranks `{library}` in axum's router and
    // `Library::named("status")` is `None` anyway: the same two guards as
    // `/api/rooms`, and the same test covers both.
    let app = if serve_status {
        app.route("/api/status", get(status))
    } else {
        app
    };

    let app = app.with_state(state);

    // Startup failures are fatal and there is nothing to recover to, so a
    // panic is the right answer here.
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|err| panic!("could not bind {addr}: {err}"));

    info!(%addr, %client_dir, %uploads_dir, %maps_dir, "slate listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            // Closing a room drops its per-client senders, which closes the
            // WebSockets and lets axum finish draining its active connections.
            // Every room, with none skipped on a failure: the one that
            // couldn't save is the one whose message matters, and the others
            // still have their own last change to flush.
            for (id, room) in rooms.iter() {
                if !room.shutdown().await {
                    error!(%id, "room shutdown completed without saving its last change");
                }
            }
        })
        .await
        .expect("server stopped unexpectedly");
}

/// Where one room's save file lives.
///
/// **`SLATE_STATE` names the primary room's file; every other room's sits
/// beside it as `<id>.json`.** This was chosen over making `SLATE_STATE` a
/// directory because it needs no migration: the Pi's env file is unchanged,
/// the live `/var/lib/slate/slate-state.json` is still the campaign, and the
/// backup that greps the tar for that filename still passes. See
/// `docs/rooms.md`.
///
/// A room id is a slug (there is a test), so it can't climb out of the
/// directory it is joined onto.
fn save_path(state_path: &str, id: &str) -> std::path::PathBuf {
    let primary = Path::new(state_path);
    if room::is_primary(id) {
        return primary.to_path_buf();
    }
    match primary.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => dir.join(format!("{id}.json")),
        None => std::path::PathBuf::from(format!("{id}.json")),
    }
}

#[derive(Serialize)]
struct RoomEntry {
    id: &'static str,
    name: &'static str,
}

/// The rooms a client may pick between.
///
/// HTTP, not a `ServerMsg`, because the picker comes before the socket: a
/// frame carrying the room list would have to arrive on a connection that
/// hasn't chosen a room yet, and every connection belongs to one room actor
/// from the moment it is registered. Keeping the choice in the URL leaves the
/// wire protocol untouched. See `docs/rooms.md`.
async fn room_listing(State(state): State<AppState>) -> Json<Vec<RoomEntry>> {
    Json(
        room::rooms(&state.site)
            .map(|(id, name)| RoomEntry { id, name })
            .collect(),
    )
}

/// The status page's credential, as a query parameter.
///
/// Accepted in the URL as well as in a header, because the reader may be a
/// jailbroken Kindle's browser, and a browser loading a URL can't set a header.
/// The DM link already puts its secret in a query string, and this key unlocks
/// only one read-only JSON document.
#[derive(Deserialize)]
struct StatusQuery {
    key: Option<String>,
}

/// A plain function like `is_dm`: one route uses it, and middleware for one
/// route adds indirection for nothing.
///
/// A `None` key can't be matched by anything, but that path is unreachable
/// because the route isn't mounted without one. It fails closed anyway, so
/// mounting the route unconditionally later couldn't silently open it.
fn status_allowed(state: &AppState, headers: &HeaderMap, query: &StatusQuery) -> bool {
    let Some(expected) = state.status_key.as_deref() else {
        return false;
    };
    let header = headers
        .get(STATUS_KEY_HEADER)
        .and_then(|value| value.to_str().ok());
    header == Some(expected) || query.key.as_deref() == Some(expected)
}

/// How the box is doing, for the status page and for whatever polls it.
///
/// **Read-only, and it must stay that way.** A restart button here would need
/// the DM secret and a much harder argument than "it would be convenient".
///
/// `build` and `host` are files somebody else wrote, passed through verbatim.
/// `server`, `rooms` and `verdict` are the server's own; each room is asked
/// over its own `mpsc`.
async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<StatusQuery>,
) -> Response {
    if !status_allowed(&state, &headers, &query) {
        warn!("rejected a request with a bad status key");
        return (StatusCode::FORBIDDEN, "not the status key").into_response();
    }

    // Every room at once, so a slow room costs the page its own timeout and
    // not the sum of them. In `room::rooms` order (the picker's order),
    // because a wall display is read at a glance and rows that moved between
    // refreshes would make that impossible.
    let rooms = futures_util::future::join_all(room::rooms(&state.site).map(|(id, name)| {
        let handle = state.rooms.get(id).cloned();
        async move {
            let reported = match handle {
                // `Some(None)` from the timeout and `None` from a closed
                // channel both mean the room didn't answer, so they flatten
                // into one.
                Some(handle) => tokio::time::timeout(STATUS_TIMEOUT, handle.status())
                    .await
                    .ok()
                    .flatten(),
                None => None,
            };
            room_status_json(id, name, reported)
        }
    }))
    .await;

    let uptime_s = state.started_at.elapsed().as_secs();
    let host = host_json(state.host_status.as_deref()).await;
    // The server's own clock, reconstructed the way the page does, so that
    // everything aged below is aged against the machine being described.
    let verdict = verdict(&rooms, state.started_unix + uptime_s, &host);

    Json(json!({
        "server": {
            "version": env!("CARGO_PKG_VERSION"),
            "started_unix": state.started_unix,
            "uptime_s": uptime_s,
        },
        "build": state.build,
        "rooms": rooms,
        "host": host,
        "verdict": verdict,
    }))
    .into_response()
}

/// Coarse, like the page's `duration`: "5d 22h" is all anyone wants from an
/// age in an alarm.
fn duration(s: u64) -> String {
    let (d, h, m) = (s / 86400, (s % 86400) / 3600, (s % 3600) / 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{s}s")
    }
}

/// What is wrong, as a list of sentences and the flags a renderer inverts a
/// cell on. Empty `alarms` is the verdict `OK`; anything in it is `ATTENTION`.
/// `UNREACHABLE` isn't here: it means this couldn't be fetched, so only the
/// reader can decide it.
///
/// **Every card is judged before any is drawn**, which is why this is one
/// function over the whole payload and not a flag per section. An alarm a
/// renderer learns about after laying out the strip becomes a number inverted
/// on screen with nothing saying why.
///
/// `pending` is *not* an alarm: a change inside the two-second debounce is
/// what a healthy room in use looks like most of the time, and an alarm that
/// fires on the ordinary case is one you learn to ignore. Only a write that is
/// failing raises one.
fn verdict(rooms: &[Value], server_now: u64, host: &Value) -> Value {
    let mut alarms: Vec<String> = Vec::new();

    for room in rooms {
        let name = room["name"].as_str().unwrap_or("?");
        if room["responding"] != true {
            alarms.push(format!("{name} is not responding"));
        } else if room["saves_failing"] == true {
            let since = match room["last_saved_unix"].as_u64() {
                Some(at) if server_now > 0 => {
                    format!(
                        "last good write {} ago",
                        duration(server_now.saturating_sub(at))
                    )
                }
                _ => "nothing written since the server started".to_string(),
            };
            alarms.push(format!("{name}: SAVES FAILING, {since}"));
        }
    }

    // A dead timer leaves a file that still parses. Age is the only thing that
    // catches it, which is why the collector stamps every write.
    let host_age_s = match (host["at"].as_u64(), server_now) {
        (Some(at), now) if now > 0 => Some(now.saturating_sub(at)),
        _ => None,
    };
    let host_stale = host_age_s.is_some_and(|age| age > HOST_STALE_S);
    let cpu_hot = host["cpu_c"].as_f64().is_some_and(|c| c >= CPU_HOT_C);
    let disk_full = host["disk_pct"]
        .as_f64()
        .is_some_and(|p| p >= DISK_FULL_PCT);
    let restarts = host["restarts"].as_u64().unwrap_or(0);
    let restarted = restarts > 0;

    if host["error"].is_string() {
        alarms.push("host collector is broken".to_string());
    }
    if let Some(age) = host_age_s.filter(|_| host_stale) {
        alarms.push(format!("host readings are {} old", duration(age)));
    }
    if host["undervoltage"] == true {
        alarms.push("undervoltage".to_string());
    }
    if let Some(c) = host["cpu_c"].as_f64().filter(|_| cpu_hot) {
        alarms.push(format!("CPU at {c}°C"));
    }
    if let Some(p) = host["disk_pct"].as_f64().filter(|_| disk_full) {
        alarms.push(format!("disk {p}% full"));
    }
    if restarted {
        let times = if restarts == 1 { "time" } else { "times" };
        alarms.push(format!("slate has restarted itself {restarts} {times}"));
    }

    json!({
        "alarms": alarms,
        "host_age_s": host_age_s,
        "host_stale": host_stale,
        "cpu_hot": cpu_hot,
        "disk_full": disk_full,
        "restarted": restarted,
    })
}

/// One room's row. **A room that didn't answer still gets a row**; dropping it
/// would leave the page looking complete.
fn room_status_json(id: &str, name: &str, reported: Option<RoomStatus>) -> Value {
    match reported {
        Some(status) => json!({
            "id": id,
            "name": name,
            "responding": true,
            "here": status.here,
            "sockets": status.sockets,
            "tokens": status.tokens,
            "unsaved": status.unsaved,
            "saves_failing": status.saves_failing,
            "last_saved_unix": status.last_saved_unix,
        }),
        None => json!({ "id": id, "name": name, "responding": false }),
    }
}

/// Parse one of the two files this server did not write.
///
/// **Tolerates a UTF-8 BOM**, which is why this exists instead of a bare
/// `from_str` at each call site. The writer may be PowerShell on Windows, whose
/// `Set-Content -Encoding utf8` emits one, and `serde_json` refuses a byte
/// order mark before `{`. The file then looks correct in every editor and is
/// dropped with one line in the journal. A file this server only relays isn't
/// the place to be strict about three bytes every text editor hides.
fn parse_foreign_json(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
}

/// The host's vitals, as whatever wrote them left them.
///
/// No file configured is `null`: there is no collector, which is the ordinary
/// case on Windows. A file that won't read or won't parse is
/// `{"error": ...}`, because a broken collector must be distinguishable from
/// one that was never installed. `null` reads as "nothing to report" and would
/// hide a dead timer for weeks.
async fn host_json(path: Option<&Path>) -> Value {
    let Some(path) = path else {
        return Value::Null;
    };
    match fs::read_to_string(path).await {
        Ok(text) => match parse_foreign_json(&text) {
            Ok(value) => value,
            Err(err) => json!({ "error": format!("{} is not valid JSON: {err}", path.display()) }),
        },
        Err(err) => json!({ "error": format!("could not read {}: {err}", path.display()) }),
    }
}

#[derive(Deserialize)]
struct WhichRoom {
    room: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(which): Query<WhichRoom>,
) -> Response {
    // Resolved before the upgrade, so a socket only ever exists attached to a
    // room. A client builds this from `/api/rooms`, so an unknown id is a stale
    // or hand-typed link. It gets a 404 instead of an upgrade, because to
    // `net.ts` a socket that opened and then said "no such room" would look
    // like the server restarting, and it would reconnect forever.
    let Some(room) = state.rooms.get(&which.room) else {
        warn!(room = %which.room, "rejected a socket for a room that does not exist");
        return (StatusCode::NOT_FOUND, "there is no such room").into_response();
    };
    let room = room.clone();

    let client = ClientId(NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed));
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| ws::handle(socket, room, client))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            error!(%err, "could not listen for Ctrl+C");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                let _ = signal.recv().await;
            }
            Err(err) => {
                error!(%err, "could not listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    info!("shutdown requested");
}

#[derive(Serialize)]
struct StoredImage {
    url: String,
}

/// The DM secret is the only credential this project has, and every endpoint
/// under `/api` except `/api/rooms` and `/api/status` wants it. A player has
/// none to offer: giving them one would be the authentication Slate doesn't
/// build.
fn is_dm(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(DM_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(state.dm_secret.as_ref())
}

fn not_the_dm(what: &str) -> (StatusCode, String) {
    warn!(%what, "rejected a request with a bad DM secret");
    (StatusCode::FORBIDDEN, format!("only the DM can {what}"))
}

#[derive(Serialize)]
struct Listing {
    /// Named neutrally because every library answers with this shape, and the
    /// client parsing it doesn't care which folder the paths came from.
    files: Vec<String>,
}

/// Which library a request is about, or a 404 saying there is no such folder.
///
/// Every handler below starts here, and none of them is reachable without the
/// secret: a player listing the maps folder sees the next dungeon in devtools.
///
/// **Neither route that hands back a URL (`pick`, `add`) touches the room.**
/// The DM's client follows one with a `set_map`, a `create_token` or a
/// `set_backdrop`, so the change players see goes through the same permission
/// check, event pipeline and visibility filter as everything else, with no
/// private way into `RoomState`.
fn library_named(
    state: &AppState,
    headers: &HeaderMap,
    segment: &str,
    doing: &str,
) -> Result<Library, (StatusCode, String)> {
    let Some(which) = Library::named(segment) else {
        return Err((StatusCode::NOT_FOUND, "there is no such library".to_owned()));
    };
    if !is_dm(state, headers) {
        return Err(not_the_dm(&format!("{doing} the {} library", which.noun())));
    }
    Ok(which)
}

/// Everything in a library, as paths to hand back to the routes below.
///
/// DM-only. No room state is involved, so this isn't invariant 4 strictly, but
/// a player reading the names of every map the DM has prepared is the same
/// kind of leak.
async fn listing(
    State(state): State<AppState>,
    UrlPath(segment): UrlPath<String>,
    headers: HeaderMap,
) -> Result<Json<Listing>, (StatusCode, String)> {
    let which = library_named(&state, &headers, &segment, "browse")?;

    Ok(Json(Listing {
        files: library::list(&which.dir(&state), which.formats()).await,
    }))
}

#[derive(Deserialize)]
struct LibraryPath {
    /// Relative to the library root, as the listing reported it.
    path: String,
}

/// Copies a file out of a library into the uploads directory and reports the
/// URL it is now served at.
///
/// The response has the same shape an add returns: to the client, a pick and
/// an add differ only in whether the bytes were already on the disk, and both
/// are followed by an ordinary `set_map` or `update_token`.
async fn pick(
    State(state): State<AppState>,
    UrlPath(segment): UrlPath<String>,
    headers: HeaderMap,
    Json(request): Json<LibraryPath>,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    let which = library_named(&state, &headers, &segment, "pick out of")?;
    copy_out(&state, which, &request.path).await
}

/// The pick itself, without the request extraction, so that `add` can finish
/// by picking the file it has just written. There is one path from "a file in
/// the library" to "the URL it is served at", which is what makes an add and a
/// later pick of the same file agree.
async fn copy_out(
    state: &AppState,
    which: Library,
    requested: &str,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    let noun = which.noun();
    let dir = which.dir(state);
    let pick = library::resolve(&dir, requested).map_err(|err| match err {
        library::PickError::Rejected => {
            warn!(path = %requested, %noun, "refused a path that left the library");
            (
                StatusCode::BAD_REQUEST,
                format!("that is not a {noun} in the library"),
            )
        }
        library::PickError::Missing => (
            StatusCode::NOT_FOUND,
            format!("there is no such {noun} in the library"),
        ),
    })?;

    // Checked before the read, so a file too large for the library isn't
    // pulled into memory just to be rejected.
    let size = fs::metadata(&pick.path).await.map_err(|err| {
        error!(%err, path = %pick.path.display(), "could not read that {noun}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not read that {noun}"),
        )
    })?;
    if size.len() > which.max_bytes() as u64 {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("that {noun} is too large"),
        ));
    }

    let bytes = fs::read(&pick.path).await.map_err(|err| {
        error!(%err, path = %pick.path.display(), "could not read that {noun}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not read that {noun}"),
        )
    })?;

    // Sniffed, not taken from the name, as in `add`: the extension decides the
    // `Content-Type` the copy is later served with, and a file's name is not
    // evidence of what is inside it.
    let Some(extension) = library::sniff(which.formats(), &bytes) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("that file is not {}", which.formats().named),
        ));
    };

    let key = format!("{}{}", which.prefix(), pick.key);
    let fingerprint: &[u8] = if which.names_by_content() {
        &bytes
    } else {
        key.as_bytes()
    };
    let name = library::copy_name(&key, fingerprint, extension);
    let path = state.uploads.join(&name);

    // An existing copy under this name is already this file, so there is
    // nothing to write. When the name comes from the bytes that is certain;
    // for a map it only means the same path was picked before. Rewriting
    // either would churn the disk and, if the write failed halfway, break the
    // URL the calibration table is keyed on.
    if fs::metadata(&path).await.is_err() {
        fs::write(&path, &bytes).await.map_err(|err| {
            error!(%err, path = %path.display(), "could not copy that {noun}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not copy that {noun}"),
            )
        })?;
        info!(%name, source = %pick.key, %noun, bytes = bytes.len(), "copied a file out of a library");
    }

    Ok(Json(StoredImage {
        url: format!("/uploads/{name}"),
    }))
}

#[derive(Deserialize)]
struct AddRequest {
    /// What the DM called the file on their own machine. A name, never a path:
    /// `library::destination` refuses anything with a separator in it instead
    /// of silently taking the last segment.
    name: String,
}

/// Writes a file into a library folder, then picks it.
///
/// **This is what the upload button does, and there is no second route.**
/// Don't write uploads straight into `uploads/` under a fresh name: that makes
/// each one a one-off that can't be found next session, and a second upload
/// of the same file gets a second URL, so the remembered calibration and the
/// walls traced on it are lost. Adding to the library first makes an uploaded
/// map as durable as one that came out of the folder, because it *is* one.
///
/// The bytes are sniffed before anything is written, so what lands in the
/// folder is a file with the extension its contents match.
async fn add(
    State(state): State<AppState>,
    UrlPath(segment): UrlPath<String>,
    headers: HeaderMap,
    Query(request): Query<AddRequest>,
    body: Bytes,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    let which = library_named(&state, &headers, &segment, "add to")?;
    let noun = which.noun();

    // The route's own limit is the largest of any library, so this is where a
    // smaller cap is applied. Refused with a sentence, where the layer would
    // drop the connection.
    if body.len() > which.max_bytes() {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("that {noun} is too large"),
        ));
    }

    let Some(extension) = library::sniff(which.formats(), &body) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("that has to be {}", which.formats().named),
        ));
    };

    let dir = which.dir(&state);
    let path =
        library::destination(&dir, &request.name, extension, which.formats()).map_err(|err| {
            match err {
                library::AddError::Rejected => {
                    warn!(name = %request.name, %noun, "refused a name a library could not hold");
                    (
                        StatusCode::BAD_REQUEST,
                        format!("that is not a name a {noun} can have"),
                    )
                }
                library::AddError::Taken => (
                    StatusCode::CONFLICT,
                    format!("there is already a {noun} called that"),
                ),
            }
        })?;

    fs::write(&path, &body).await.map_err(|err| {
        error!(%err, path = %path.display(), "could not add that {noun}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not add that {noun} to the library"),
        )
    })?;

    // `destination` proved this is one plain component directly in the folder,
    // so the file's own name is the path a pick asks for.
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not add that {noun} to the library"),
        ));
    };
    info!(%name, %noun, bytes = body.len(), "added a file to a library");

    copy_out(&state, which, name).await
}

/// Deletes a file from a library folder.
///
/// **The copy in `uploads/` is left alone**, and so is everything keyed on the
/// URL it is served at. Removing a map from the picker means "stop offering me
/// this", not "erase this from the room": a map on the board is still served,
/// and the grid, walls and paint the DM prepared on it stay on the shelf.
/// Re-adding a file under the same name later lands on the same URL and finds
/// all of it again.
///
/// Only ever a file: `library::resolve` refuses a directory, so nothing here
/// can empty a folder.
async fn remove(
    State(state): State<AppState>,
    UrlPath(segment): UrlPath<String>,
    headers: HeaderMap,
    Json(request): Json<LibraryPath>,
) -> Result<StatusCode, (StatusCode, String)> {
    let which = library_named(&state, &headers, &segment, "remove from")?;
    let noun = which.noun();

    let dir = which.dir(&state);
    let pick = library::resolve(&dir, &request.path).map_err(|err| match err {
        library::PickError::Rejected => {
            warn!(path = %request.path, %noun, "refused a path that left the library");
            (
                StatusCode::BAD_REQUEST,
                format!("that is not a {noun} in the library"),
            )
        }
        library::PickError::Missing => (
            StatusCode::NOT_FOUND,
            format!("there is no such {noun} in the library"),
        ),
    })?;

    fs::remove_file(&pick.path).await.map_err(|err| {
        error!(%err, path = %pick.path.display(), "could not remove that {noun}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not remove that {noun}"),
        )
    })?;

    info!(path = %pick.key, %noun, "removed a file from a library");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_libraries_are_named() {
        // The path segment routes sixteen operations through four handlers,
        // so an unknown one has to be a 404, not something the fallback
        // serves an index page for.
        assert!(Library::named("maps").is_some());
        assert!(Library::named("portraits").is_some());
        assert!(Library::named("backdrops").is_some());
        // This plural only: the client drops one letter to get "track".
        assert!(Library::named("tracks").is_some());
        for nonsense in ["map", "Maps", "track", "uploads", "..", ""] {
            assert!(
                Library::named(nonsense).is_none(),
                "{nonsense} is not a library"
            );
        }
    }

    #[test]
    fn the_primary_rooms_save_file_is_slate_state_itself() {
        // Why `SLATE_STATE` isn't a directory. Change this and the Pi's env
        // file, the live campaign save and the backup that greps the tar for
        // this filename all need a migration.
        let primary = room::rooms(room::DEFAULT_SITE)
            .map(|(id, _)| id)
            .find(|id| room::is_primary(id))
            .expect("a primary room");
        assert_eq!(
            save_path("/var/lib/slate/slate-state.json", primary),
            Path::new("/var/lib/slate/slate-state.json")
        );
        // Every site's first room follows the same rule, in its own process's
        // directory: `sword-legend`'s save is its own `SLATE_STATE`, not a sibling.
        assert_eq!(
            save_path(
                "/var/lib/slate-sword-legend/slate-state.json",
                "sword-legend"
            ),
            Path::new("/var/lib/slate-sword-legend/slate-state.json")
        );
    }

    #[test]
    fn every_other_rooms_save_file_sits_beside_it() {
        for (id, _) in room::rooms(room::DEFAULT_SITE).filter(|(id, _)| !room::is_primary(id)) {
            assert_eq!(
                save_path("/var/lib/slate/slate-state.json", id),
                Path::new("/var/lib/slate").join(format!("{id}.json"))
            );
            // A bare filename has no parent directory to join onto, which is
            // what the drivers and a plain `cargo run` both pass.
            assert_eq!(
                save_path("slate-state.json", id),
                Path::new(&format!("{id}.json"))
            );
        }
    }

    #[test]
    fn rooms_is_not_a_library() {
        // `/api/rooms` is the one route under `/api` without the DM secret in
        // front of it. Static segments outrank `{library}` in axum's router,
        // so this is a second guard: if that ever changed, a `rooms` library
        // would put the room list behind the secret the picker can't offer.
        assert!(Library::named("rooms").is_none());
        // `/api/status` is the second static segment under `/api` and needs
        // the same guarantee for the opposite reason: a `status` library would
        // put the map folder behind the key a wall display holds.
        assert!(Library::named("status").is_none());
    }

    // --- the status page's credential -------------------------------------

    /// Enough of an `AppState` to ask the guard a question. The room table is
    /// empty because nothing here reaches an actor.
    fn app_state(status_key: Option<&str>) -> AppState {
        AppState {
            rooms: Arc::new(HashMap::new()),
            site: room::DEFAULT_SITE.into(),
            dm_secret: "the-dm-secret".into(),
            uploads: Path::new("uploads").into(),
            maps: Path::new("maps").into(),
            portraits: Path::new("portraits").into(),
            backdrops: Path::new("backdrops").into(),
            tracks: Path::new("tracks").into(),
            status_key: status_key.map(Arc::from),
            host_status: None,
            build: None,
            started_at: Instant::now(),
            started_unix: 0,
        }
    }

    fn with_status_header(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::HeaderName::from_static(STATUS_KEY_HEADER),
            axum::http::HeaderValue::from_str(value).expect("a legal header value"),
        );
        headers
    }

    fn query(key: Option<&str>) -> StatusQuery {
        StatusQuery {
            key: key.map(str::to_owned),
        }
    }

    #[test]
    fn the_status_key_is_accepted_in_a_header_or_in_the_url() {
        // Both: a Kindle's browser loads a URL and can't set a header. TRMNL
        // sends the header.
        let state = app_state(Some("status-key"));
        assert!(status_allowed(
            &state,
            &with_status_header("status-key"),
            &query(None)
        ));
        assert!(status_allowed(
            &state,
            &HeaderMap::new(),
            &query(Some("status-key"))
        ));
    }

    #[test]
    fn a_wrong_status_key_is_refused_by_either_route_in() {
        let state = app_state(Some("status-key"));
        assert!(!status_allowed(
            &state,
            &with_status_header("nearly"),
            &query(None)
        ));
        assert!(!status_allowed(&state, &HeaderMap::new(), &query(Some(""))));
        assert!(!status_allowed(&state, &HeaderMap::new(), &query(None)));
    }

    #[test]
    fn the_status_key_and_the_dm_secret_are_not_each_other() {
        // Why there are two credentials. A display on the wall holds the
        // status key; if that opened the library routes, it would be a second
        // copy of the DM secret.
        let state = app_state(Some("status-key"));
        assert!(!status_allowed(
            &state,
            &with_status_header("the-dm-secret"),
            &query(None)
        ));
        assert!(!status_allowed(
            &state,
            &HeaderMap::new(),
            &query(Some("the-dm-secret"))
        ));

        let mut dm_headers = HeaderMap::new();
        dm_headers.insert(
            axum::http::HeaderName::from_static(DM_SECRET_HEADER),
            axum::http::HeaderValue::from_static("status-key"),
        );
        assert!(!is_dm(&state, &dm_headers), "and not the other way round");
    }

    #[test]
    fn with_no_key_configured_nothing_gets_in() {
        // Unreachable in practice (the route isn't mounted without a key), but
        // written to fail closed so that mounting it unconditionally one day
        // couldn't silently open it.
        let state = app_state(None);
        assert!(!status_allowed(&state, &HeaderMap::new(), &query(None)));
        assert!(!status_allowed(
            &state,
            &with_status_header(""),
            &query(Some(""))
        ));
    }

    // --- what the page is handed ------------------------------------------

    #[test]
    fn a_room_that_did_not_answer_still_gets_a_row() {
        // Dropping the row would leave a page that looks complete while a
        // room is wedged.
        let row = room_status_json("campaign", "Campaign", None);
        assert_eq!(row["id"], "campaign");
        assert_eq!(row["responding"], false);
        assert!(
            row.get("here").is_none(),
            "nothing to report is not an empty list"
        );
    }

    fn room_row(name: &str, saves_failing: bool, last_saved_unix: Option<u64>) -> Value {
        room_status_json(
            &name.to_lowercase(),
            name,
            Some(RoomStatus {
                here: vec![],
                sockets: 0,
                tokens: 0,
                unsaved: true,
                saves_failing,
                last_saved_unix,
            }),
        )
    }

    #[test]
    fn a_healthy_server_has_nothing_to_say() {
        // `unsaved` is set on this row and must not raise an alarm: a change
        // inside the debounce is the ordinary case.
        let v = verdict(&[room_row("Campaign", false, Some(90))], 100, &Value::Null);
        assert_eq!(v["alarms"], json!([]));
        assert_eq!(v["host_age_s"], Value::Null, "no collector, no age");
        assert_eq!(v["host_stale"], false);
        assert_eq!(v["restarted"], false);
    }

    #[test]
    fn a_failing_save_says_how_much_is_at_risk() {
        let v = verdict(
            &[room_row("Campaign", true, Some(1_000))],
            1_000 + 3 * 3600,
            &Value::Null,
        );
        assert_eq!(
            v["alarms"],
            json!(["Campaign: SAVES FAILING, last good write 3h 0m ago"])
        );
        let v = verdict(&[room_row("Campaign", true, None)], 5_000, &Value::Null);
        assert_eq!(
            v["alarms"],
            json!(["Campaign: SAVES FAILING, nothing written since the server started"])
        );
    }

    #[test]
    fn a_room_that_did_not_answer_is_an_alarm() {
        let v = verdict(
            &[room_status_json("halloween", "Halloween", None)],
            100,
            &Value::Null,
        );
        assert_eq!(v["alarms"], json!(["Halloween is not responding"]));
    }

    #[test]
    fn the_host_is_judged_on_the_servers_clock() {
        // Fresh: a reading 200s old is inside the collector's headroom.
        let fresh = verdict(&[], 10_000, &json!({ "at": 9_800 }));
        assert_eq!(fresh["host_age_s"], 200);
        assert_eq!(fresh["host_stale"], false);
        assert_eq!(fresh["alarms"], json!([]));
        // Stale: the file still parses and looks like data. Only its age can
        // catch a dead timer.
        let stale = verdict(&[], 10_000, &json!({ "at": 9_000 }));
        assert_eq!(stale["host_stale"], true);
        assert_eq!(stale["alarms"], json!(["host readings are 16m old"]));
    }

    #[test]
    fn each_host_threshold_names_its_number() {
        let host = json!({
            "at": 100, "cpu_c": 76.5, "disk_pct": 91, "undervoltage": true, "restarts": 1
        });
        let v = verdict(&[], 100, &host);
        assert_eq!(
            v["alarms"],
            json!([
                "undervoltage",
                "CPU at 76.5°C",
                "disk 91% full",
                "slate has restarted itself 1 time"
            ])
        );
        assert_eq!(v["cpu_hot"], true);
        assert_eq!(v["disk_full"], true);
        assert_eq!(v["restarted"], true);

        // Just under each threshold raises nothing, and neither does a board
        // that dipped and recovered: `undervoltage_ever` is a row, not an
        // alarm.
        let calm = json!({
            "at": 100, "cpu_c": 74.9, "disk_pct": 89.9, "undervoltage": false,
            "undervoltage_ever": true, "restarts": 0
        });
        assert_eq!(verdict(&[], 100, &calm)["alarms"], json!([]));
    }

    #[test]
    fn a_broken_collector_is_an_alarm_and_a_missing_one_is_not() {
        let broken = verdict(&[], 100, &json!({ "error": "could not read host.json" }));
        assert_eq!(broken["alarms"], json!(["host collector is broken"]));
        assert_eq!(verdict(&[], 100, &Value::Null)["alarms"], json!([]));
    }

    #[test]
    fn durations_are_coarse_past_a_minute() {
        assert_eq!(duration(0), "0s");
        assert_eq!(duration(59), "59s");
        assert_eq!(duration(60), "1m");
        assert_eq!(duration(3_599), "59m");
        assert_eq!(duration(3_600), "1h 0m");
        assert_eq!(duration(90_000), "1d 1h");
    }

    #[tokio::test]
    async fn a_file_written_by_powershell_still_parses() {
        // Windows PowerShell 5.1 writes a UTF-8 BOM and calls it utf8. Both
        // files this server relays may be written by it, and three bytes an
        // editor hides must not turn a build stamp into a blank card. This bug
        // has happened.
        let path = std::env::temp_dir().join(format!(
            "slate-bom-{}-{}.json",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        std::fs::write(&path, "﻿{\"sha\":\"395e1b6\"}".as_bytes()).expect("write");

        let value = host_json(Some(&path)).await;
        assert_eq!(
            value["sha"], "395e1b6",
            "a byte order mark is not a parse error here"
        );
        assert!(value.get("error").is_none());

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_missing_collector_and_a_broken_one_read_differently() {
        // No file configured is the ordinary case on a machine with no
        // collector. A file that won't read has to say so: a dead timer that
        // looked like "nothing to report" would hide for weeks.
        assert_eq!(host_json(None).await, Value::Null);

        let absent = std::env::temp_dir().join(format!(
            "slate-no-such-host-{}-{}.json",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let broken = host_json(Some(&absent)).await;
        assert!(
            broken["error"].is_string(),
            "an unreadable file reports an error, not null"
        );
    }

    #[test]
    fn formats_are_recognised_by_their_magic_bytes() {
        assert_eq!(
            library::sniff(&library::IMAGES, b"\x89PNG\r\n\x1a\n\x00\x00"),
            Some("png")
        );
        assert_eq!(
            library::sniff(&library::IMAGES, &[0xff, 0xd8, 0xff, 0xe0, 0x00]),
            Some("jpg")
        );
        assert_eq!(
            library::sniff(&library::IMAGES, b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("webp")
        );
    }

    /// The name `pick` would land on, without the filesystem it reads from.
    fn copy_name_for(which: Library, path: &str, bytes: &[u8], extension: &str) -> String {
        let key = format!("{}{}", which.prefix(), path);
        let fingerprint: &[u8] = if which.names_by_content() {
            bytes
        } else {
            key.as_bytes()
        };
        library::copy_name(&key, fingerprint, extension)
    }

    #[test]
    fn one_name_in_two_libraries_is_two_copies() {
        // Without the prefix these collide: the second pick finds the first
        // already written, skips the write, and hands back the wrong image.
        let as_map = copy_name_for(Library::Maps, "cave.png", b"an image", "png");
        let as_portrait = copy_name_for(Library::Portraits, "cave.png", b"an image", "png");
        assert_ne!(as_map, as_portrait);
    }

    #[test]
    fn a_picked_map_keeps_the_name_it_has_always_had() {
        // The calibration table is keyed on the URL this produces, so changing
        // either would orphan every map the DM has ever calibrated.
        assert_eq!(Library::Maps.prefix(), "");
        assert!(!Library::Maps.names_by_content());
    }

    #[test]
    fn a_replaced_portrait_is_a_new_copy_and_a_replaced_map_is_not() {
        // Both halves of `Library::names_by_content`, so neither can be
        // flipped without a test saying what it costs.
        assert_ne!(
            copy_name_for(Library::Portraits, "cleo.jpg", b"the old art", "jpg"),
            copy_name_for(Library::Portraits, "cleo.jpg", b"the new art", "jpg"),
            "a swapped portrait must stop resolving to the copy it replaced"
        );
        assert_eq!(
            copy_name_for(Library::Maps, "cave.png", b"the old art", "png"),
            copy_name_for(Library::Maps, "cave.png", b"the new art", "png"),
            "a map's URL must survive its art changing, or its calibration is lost"
        );
    }

    #[test]
    fn anything_else_is_not_a_map() {
        assert_eq!(library::sniff(&library::IMAGES, b""), None);
        assert_eq!(library::sniff(&library::IMAGES, b"GIF89a"), None);
        assert_eq!(library::sniff(&library::IMAGES, b"<!doctype html>"), None);
        assert_eq!(library::sniff(&library::IMAGES, b"\x7fELF"), None);
        // A truncated RIFF header must not be read past the end.
        assert_eq!(library::sniff(&library::IMAGES, b"RIFF\x00\x00\x00"), None);
        // RIFF, but a wave file.
        assert_eq!(
            library::sniff(&library::IMAGES, b"RIFF\x00\x00\x00\x00WAVEfmt "),
            None
        );
    }

    #[test]
    fn a_track_library_sniffs_audio() {
        let audio = &library::AUDIO;
        assert_eq!(library::sniff(audio, b"OggS\x00\x02\x00\x00"), Some("ogg"));
        assert_eq!(library::sniff(audio, b"ID3\x04\x00\x00\x00"), Some("mp3"));
        // A bare MPEG-1 Layer III frame: sync, version 11, layer 01.
        assert_eq!(
            library::sniff(audio, &[0xff, 0xfb, 0x90, 0x00]),
            Some("mp3")
        );
        assert_eq!(
            library::sniff(audio, b"RIFF\x00\x00\x00\x00WAVEfmt "),
            Some("wav")
        );
    }

    #[test]
    fn the_reserved_mpeg_fields_are_not_a_track() {
        let audio = &library::AUDIO;
        // Sync, but MPEG version `01`, which is reserved.
        assert_eq!(library::sniff(audio, &[0xff, 0xeb, 0x90, 0x00]), None);
        // Sync, but layer `00`, which is reserved.
        assert_eq!(library::sniff(audio, &[0xff, 0xf9, 0x90, 0x00]), None);
        // Sync, but bitrate index `1111`, which is invalid.
        assert_eq!(library::sniff(audio, &[0xff, 0xfb, 0xf0, 0x00]), None);
        // Sync bits alone, with nothing after them to check.
        assert_eq!(library::sniff(audio, &[0xff]), None);
    }

    #[test]
    fn a_riff_container_is_a_webp_here_and_a_wav_there() {
        // Both files open with `RIFF` and each is refused by the other's
        // table, which is why the table is per library and not one list
        // everything is checked against.
        let webp = b"RIFF\x00\x00\x00\x00WEBPVP8 ";
        let wav = b"RIFF\x00\x00\x00\x00WAVEfmt ";
        assert_eq!(library::sniff(&library::IMAGES, webp), Some("webp"));
        assert_eq!(library::sniff(&library::AUDIO, webp), None);
        assert_eq!(library::sniff(&library::AUDIO, wav), Some("wav"));
        assert_eq!(library::sniff(&library::IMAGES, wav), None);
    }

    #[test]
    fn an_image_is_not_a_track_and_a_track_is_not_an_image() {
        assert_eq!(
            library::sniff(&library::AUDIO, b"\x89PNG\r\n\x1a\n\x00\x00"),
            None
        );
        assert_eq!(library::sniff(&library::IMAGES, b"OggS\x00\x02"), None);
        assert_eq!(library::sniff(&library::IMAGES, b"ID3\x04\x00"), None);
    }

    #[test]
    fn every_library_but_the_tracks_holds_pictures() {
        // The grouped arm in `Library::formats`, as an assertion: adding a
        // library must not change what the three picture libraries accept.
        for which in [Library::Maps, Library::Portraits, Library::Backdrops] {
            assert_eq!(
                library::sniff(which.formats(), b"\x89PNG\r\n\x1a\n"),
                Some("png"),
                "{} must still take a PNG",
                which.noun()
            );
            assert_eq!(library::sniff(which.formats(), b"OggS\x00\x02"), None);
        }
        assert_eq!(
            library::sniff(Library::Tracks.formats(), b"\x89PNG\r\n\x1a\n"),
            None
        );
    }
}

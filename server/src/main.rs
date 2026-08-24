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

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tower_http::services::ServeDir;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::protocol::ClientId;
use crate::room::RoomHandle;

/// Big enough for a detailed battle map, small enough that a mistyped upload
/// cannot fill the disk. axum's own default is 2 MB, which most maps exceed.
const MAX_MAP_BYTES: usize = 25 * 1024 * 1024;
/// Token art is drawn inside a circle a cell wide. Anything approaching this is
/// already far more image than the board can show.
const MAX_TOKEN_BYTES: usize = 4 * 1024 * 1024;
/// Protocol frames are tiny JSON commands. Keeping this bounded prevents a
/// public WebSocket from using one frame to reserve an unreasonable buffer.
///
/// **Inbound only** — `max_message_size` and `max_frame_size` gate tungstenite's
/// *read* path, so nothing here bounds a `Welcome` on its way out. What it does
/// bound is every command, and one of them carries a variable-length collection:
/// `SetFogOverride` names its cells one pair at a time. `MAX_OVERRIDE_CELLS` is
/// reconciled against this number and a test in `room::tests::fog_of_war`
/// serialises the largest legal one and asserts it fits — see `docs/net.md`.
/// It shipped at 16 KiB, which was under a legitimate room fill and dropped the
/// DM's socket rather than refusing the command.
///
/// The cost of the larger number is that a socket which has not said who it is
/// yet may push this much; acceptable behind a tunnel with a DM secret, and
/// worth saying out loud rather than leaving implied.
pub(crate) const MAX_WS_MESSAGE_BYTES: usize = 128 * 1024;
const DM_SECRET_HEADER: &str = "x-slate-dm-secret";

/// Every room's handle, keyed by the id in `room::ROOMS`.
///
/// **No lock**, which is the shape of the whole feature: the rooms are known
/// before the first socket opens, so this map is built once in `main` and only
/// ever read. `ROADMAP.md` budgeted an `RwLock` here — a lock guards a table
/// that changes, and nothing changes this one. It would arrive with a room the
/// DM could create at runtime, which is not built and is not wanted.
///
/// Read on connect only, and never on a token move: a socket resolves its room
/// once in `ws_handler` and then talks to that actor's `mpsc` directly, exactly
/// as it did when there was one handle in this struct.
#[derive(Clone)]
struct AppState {
    rooms: Arc<HashMap<String, RoomHandle>>,
    /// The room holds its own copy for the WebSocket handshake. This one exists
    /// because an HTTP upload never reaches the room actor to be checked there.
    dm_secret: Arc<str>,
    uploads: Arc<Path>,
    /// The three libraries the DM picks out of. None is served directly — a
    /// pick copies into `uploads`, so there stays one kind of image URL.
    maps: Arc<Path>,
    portraits: Arc<Path>,
    backdrops: Arc<Path>,
}

/// Which folder a listing or a pick is about.
///
/// A map and a portrait are the same operation — prove some bytes are an image,
/// give them a name of ours, report the URL — against different directories and
/// different size caps, exactly as the two upload routes already are. This is
/// what tells them apart, so there is one copy of the path handling that
/// `library.rs` guards rather than two that can drift.
#[derive(Clone, Copy)]
enum Library {
    Maps,
    Portraits,
    /// Pictures shown *instead of* the board, with no grid on them and nothing
    /// standing on them. A third folder rather than a corner of `maps/` because
    /// a picker over the maps is a list of things to play on, and mixing in the
    /// things you cannot play on is what makes both lists worse.
    Backdrops,
}

impl Library {
    /// The folder named by the `{library}` segment of an `/api` path, which is
    /// also the plural the client's `createLibraryList` is built around.
    fn named(segment: &str) -> Option<Self> {
        match segment {
            "maps" => Some(Self::Maps),
            "portraits" => Some(Self::Portraits),
            "backdrops" => Some(Self::Backdrops),
            _ => None,
        }
    }

    fn dir(self, state: &AppState) -> Arc<Path> {
        match self {
            Self::Maps => state.maps.clone(),
            Self::Portraits => state.portraits.clone(),
            Self::Backdrops => state.backdrops.clone(),
        }
    }

    /// Named in the refusals, so a DM reading one knows which list it is about.
    fn noun(self) -> &'static str {
        match self {
            Self::Maps => "map",
            Self::Portraits => "portrait",
            Self::Backdrops => "backdrop",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Maps => MAX_MAP_BYTES,
            Self::Portraits => MAX_TOKEN_BYTES,
            // A map's cap and not a portrait's: a backdrop fills the whole
            // window, so it is the same kind of picture as a battle map with
            // the grid left off.
            Self::Backdrops => MAX_MAP_BYTES,
        }
    }

    /// Prepended to the key the copy's name is derived from, so `cave.png` in
    /// one library and `cave.png` in the other do not resolve to one file — the
    /// second pick would find the first already there, skip the write, and hand
    /// back a map as somebody's portrait.
    ///
    /// **Maps deliberately keep the empty prefix.** Their copy names predate this
    /// and the remembered calibration table is keyed on the URL those names
    /// produce, so changing it would silently orphan every map the DM has ever
    /// calibrated.
    fn prefix(self) -> &'static str {
        match self {
            Self::Maps => "",
            Self::Portraits => "portrait/",
            Self::Backdrops => "backdrop/",
        }
    }

    /// Whether a copy is named from the bytes it holds rather than from the path
    /// it came from. The second axis a library differs by, and for the same
    /// reason as `prefix`: what feeds the name decides what a re-pick resolves
    /// to.
    ///
    /// **Portraits are named from their contents** so that replacing the art in
    /// the folder replaces it on the token. Named from the path, the copy is
    /// written once and every later pick finds it already there and skips the
    /// write — the DM swaps a portrait, re-picks it, builds a new token, and is
    /// handed the old image every time with nothing to say why.
    ///
    /// **Maps are named from their path, and must stay that way.** The
    /// remembered calibration table is keyed on the URL these names produce, so
    /// naming a map by its contents would orphan every map the DM has ever
    /// calibrated — the same trap as giving maps a prefix, one field over. The
    /// cost is that replacing a map's art in `maps/` still does nothing; that is
    /// the standing asymmetry with uploads described in `docs/maps.md`, and
    /// closing it means migrating the calibration table rather than changing
    /// this.
    fn names_by_content(self) -> bool {
        match self {
            Self::Maps => false,
            Self::Portraits => true,
            // The portraits' answer, for the portraits' reason and with none of
            // the maps' objection: nothing is keyed on a backdrop's URL — the
            // room holds one, and holding a stale one is what a re-pick is for
            // — so replacing the art in the folder can and should replace the
            // picture the table is looking at.
            Self::Backdrops => true,
        }
    }
}

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

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
    // random secret per boot, logged once — fine for a session, but set it in
    // the environment if you want the DM link to survive a restart.
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

    let uploads_dir = std::env::var("SLATE_UPLOADS").unwrap_or_else(|_| "uploads".to_owned());
    std::fs::create_dir_all(&uploads_dir)
        .unwrap_or_else(|err| panic!("could not create {uploads_dir}: {err}"));

    // Deliberately not created if any is absent. They hold files someone put
    // there on purpose, so an empty one conjured at boot would hide a mistyped
    // SLATE_MAPS, SLATE_PORTRAITS or SLATE_BACKDROPS behind a picker that
    // simply looks empty.
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

    let mut rooms = HashMap::new();
    for (id, name) in room::rooms() {
        let path = save_path(&state_path, id);
        let store = store::Store::new(path.clone());

        // Startup, so a panic is the right answer here — and refusing to boot is
        // the safe answer. Starting a fresh room on top of a save we could not
        // read would destroy the group's game with the first token move. One
        // unreadable room stops the whole process rather than the others
        // carrying on without it, for the same reason: a server that is
        // *partly* up is one the DM finds out about mid-session.
        let saved = store
            .load()
            .await
            .unwrap_or_else(|err| panic!("could not load {}: {err}", path.display()));

        let demo = room::is_primary(id);
        match (&saved, demo) {
            (Some(_), _) => info!(%id, path = %path.display(), "restored a room from disk"),
            (None, true) => info!(%id, "no save found; starting from the built-in room"),
            (None, false) => info!(%id, "no save found; starting an empty room"),
        }

        // `ROOMS` is a const and its ids are unique — there is a test for it —
        // so this cannot silently drop a room.
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
        dm_secret: dm_secret.into(),
        uploads: Path::new(&uploads_dir).into(),
        maps: Path::new(&maps_dir).into(),
        portraits: Path::new(&portraits_dir).into(),
        backdrops: Path::new(&backdrops_dir).into(),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        // **The one route under `/api` that is not the DM's**, and it has to be:
        // it is what the room picker is built from, and a player has no
        // credential to offer. What it discloses is the room names, which are
        // not secrets in the way the map library's contents are — a name on a
        // picker against a list of every dungeon the DM has prepared. The
        // unguessable subdomain is the access control here as it is everywhere
        // else in this project.
        //
        // Static segments outrank `{library}` in axum's router, and
        // `Library::named("rooms")` is `None` regardless, so this is safe twice
        // over. There is a test for the second half.
        .route("/api/rooms", get(room_listing))
        // **Three libraries and four things to do to one**, so the folder is a
        // path segment rather than twelve routes each a line of their own. It
        // was six wrappers when there were two verbs; `Library::named` is what
        // replaced them, and an unknown segment is a 404 rather than the client
        // fallback it used to fall through to.
        //
        // There is no separate upload route any more. Adding an image *is*
        // putting it in the library — see `add`, which ends by picking the file
        // it just wrote, so an upload and a pick answer with the same URL for
        // the same bytes.
        .route("/api/{library}", get(listing))
        .route("/api/{library}/pick", post(pick))
        // The body limit is the largest any library allows, because one route
        // serves all three; the per-library cap is checked inside the handler,
        // where it can be refused with a sentence instead of a dropped
        // connection.
        .route(
            "/api/{library}/add",
            post(add).layer(DefaultBodyLimit::max(MAX_MAP_BYTES)),
        )
        .route("/api/{library}/remove", post(remove))
        .nest_service("/uploads", ServeDir::new(&uploads_dir))
        .fallback_service(ServeDir::new(&client_dir).append_index_html_on_directories(true))
        .with_state(state);

    // Startup failures are fatal and there is nothing to recover to, so this is
    // the one place a panic is the right answer.
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|err| panic!("could not bind {addr}: {err}"));

    info!(%addr, %client_dir, %uploads_dir, %maps_dir, "slate listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            // Closing a room drops its per-client senders, which closes the
            // WebSockets and lets axum finish draining its active connections.
            // Every room, and none of them skipped on a failure: the one that
            // could not save is the one whose message matters, and the others
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
/// **`SLATE_STATE` still names the primary room's file, exactly as it always
/// has; every other room's sits beside it as `<id>.json`.** That is the whole
/// rule, and it was chosen over making `SLATE_STATE` a directory because it
/// needs no migration: the Pi's env file is unchanged, the live
/// `/var/lib/slate/slate-state.json` keeps being the campaign, and the backup
/// that greps the tar for that filename keeps passing. See `docs/rooms.md`.
///
/// A room id is a slug — there is a test — so it cannot climb out of the
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
/// The picker cannot be drawn without it and the picker comes before the
/// socket, which is why this is HTTP rather than a `ServerMsg`: a frame
/// carrying the room list would have to arrive on a connection that has not
/// chosen a room yet, and every connection in this server belongs to exactly
/// one room actor from the moment it is registered. Keeping the choice in the
/// URL is what leaves the wire protocol untouched — see `docs/rooms.md`.
async fn room_listing() -> Json<Vec<RoomEntry>> {
    Json(
        room::rooms()
            .map(|(id, name)| RoomEntry { id, name })
            .collect(),
    )
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
    // room. A client builds this from `/api/rooms`, so an id that is not here is
    // a stale link or a hand-typed one — 404 rather than an upgrade, because a
    // socket that opened and then said "no such room" would be indistinguishable
    // to `net.ts` from the server restarting, and it would reconnect forever.
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
/// under `/api` wants it. A player has none to offer, which is the point: giving
/// them one would be the authentication Slate deliberately does not build.
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
    /// Neutrally named because both libraries answer with this shape, and the
    /// client parsing it does not care which folder the paths came out of.
    files: Vec<String>,
}

/// **Neither of the two routes that hand back a URL touches the room.** The DM's
/// client follows one with a `set_map`, a `create_token` or a `set_backdrop`, so
/// the change players actually see goes through the same permission check, event
/// pipeline and visibility filter as everything else, rather than getting a
/// private back door into `RoomState`.
/// Which library a request is about, or a 404 saying there is no such folder.
///
/// Every handler below starts here, and none of them is reachable without the
/// secret: the DM's credential is the only one Slate has, and a player
/// enumerating the maps folder is the next dungeon in devtools.
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
/// DM-only. No room state is involved, so this is not invariant 4 in the strict
/// sense, but a player reading off the names of every map the DM has prepared is
/// the same problem wearing a different hat.
async fn listing(
    State(state): State<AppState>,
    UrlPath(segment): UrlPath<String>,
    headers: HeaderMap,
) -> Result<Json<Listing>, (StatusCode, String)> {
    let which = library_named(&state, &headers, &segment, "browse")?;

    Ok(Json(Listing {
        files: library::list(&which.dir(&state)).await,
    }))
}

#[derive(Deserialize)]
struct LibraryPath {
    /// Relative to the library root, exactly as the listing reported it.
    path: String,
}

/// Copies a file out of a library into the uploads directory and reports the
/// URL it is now served at.
///
/// The response is deliberately the same shape an add returns: from the client's
/// point of view a pick and an add differ only in whether the bytes were already
/// on the disk, and both are followed by an ordinary `set_map` or `update_token`.
async fn pick(
    State(state): State<AppState>,
    UrlPath(segment): UrlPath<String>,
    headers: HeaderMap,
    Json(request): Json<LibraryPath>,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    let which = library_named(&state, &headers, &segment, "pick out of")?;
    copy_out(&state, which, &request.path).await
}

/// The pick itself, without the extraction — so that `add` can finish by picking
/// the file it has just written rather than working out the same URL a second
/// way. There is one path from "a file in the library" to "a URL it is served
/// at", which is what makes an add and a later pick of the same file agree.
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

    // Checked before the read rather than after, so a file that does not belong
    // in a library cannot be pulled into memory just to be rejected.
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

    // Sniffed rather than taken from the name, for the same reason an add is:
    // the extension decides the `Content-Type` the copy is later served with, and
    // a file's name is not evidence of what is inside it.
    let Some(extension) = image_format(&bytes) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "that file is not a PNG, JPEG or WebP image".to_owned(),
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

    // An existing copy under this name is already this file, so there is nothing
    // to write. For a portrait that is a fact about the bytes — the name came
    // from them — and for a map it is the weaker promise that the same path was
    // picked before. Rewriting either would only churn the disk and, worse,
    // break the URL the calibration table is keyed on if the write failed
    // halfway.
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
    /// What the DM called the file on their own machine. A name and never a
    /// path — `library::destination` refuses anything with a separator in it,
    /// rather than taking the last segment and quietly meaning something else.
    name: String,
}

/// Writes an image into a library folder, then picks it.
///
/// **This is what the upload button does now, and there is no second route.**
/// An image the DM uploads used to land in `uploads/` under a fresh UUID, which
/// made it a one-off: it could not be found again next session and a second
/// upload of the same file was a second URL, so the remembered calibration and
/// the walls traced on it belonged to nobody. Adding to the library first makes
/// an uploaded map exactly as durable as one that came out of the folder,
/// because it *is* one.
///
/// The bytes are sniffed before anything is written, so what lands in the folder
/// is an image with the extension it actually has.
async fn add(
    State(state): State<AppState>,
    UrlPath(segment): UrlPath<String>,
    headers: HeaderMap,
    Query(request): Query<AddRequest>,
    body: Bytes,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    let which = library_named(&state, &headers, &segment, "add to")?;
    let noun = which.noun();

    // The route's own limit is the largest of the three, so this is where a
    // portrait-sized cap is actually applied. Refused with a sentence rather
    // than by dropping the connection, which is what the layer would do.
    if body.len() > which.max_bytes() {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("that {noun} is too large"),
        ));
    }

    let Some(extension) = image_format(&body) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "that has to be a PNG, JPEG or WebP image".to_owned(),
        ));
    };

    let dir = which.dir(&state);
    let path = library::destination(&dir, &request.name, extension).map_err(|err| match err {
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
/// **The copy in `uploads/` is deliberately left alone**, and so is everything
/// keyed on the URL it is served at. Removing a map from the picker is saying
/// "stop offering me this", not "erase this from the room" — a map currently on
/// the board goes on being served, and the grid, the walls and the paint the DM
/// prepared on it stay on the shelf. Re-adding a file under the same name later
/// lands on the same URL and finds all of it waiting.
///
/// Only ever a file: `library::resolve` refuses a directory, so there is nothing
/// here that can empty a folder.
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

/// Identifies the format from its magic bytes, and deliberately not from the
/// filename or the `Content-Type` header — the client controls both, and neither
/// is evidence of what the file actually is. The extension this returns is what
/// decides the `Content-Type` browsers are later served the file with.
fn image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_libraries_are_named() {
        // The path segment is what routes twelve operations through four
        // handlers, so an unknown one has to be a 404 rather than something the
        // fallback quietly serves an index page for.
        assert!(Library::named("maps").is_some());
        assert!(Library::named("portraits").is_some());
        assert!(Library::named("backdrops").is_some());
        for nonsense in ["map", "Maps", "uploads", "..", ""] {
            assert!(
                Library::named(nonsense).is_none(),
                "{nonsense} is not a library"
            );
        }
    }

    #[test]
    fn the_primary_rooms_save_file_is_slate_state_itself() {
        // The whole of why `SLATE_STATE` did not become a directory. Change
        // this and the Pi's env file, the live campaign save and the backup
        // that greps the tar for this filename all need a migration.
        let primary = room::rooms()
            .map(|(id, _)| id)
            .find(|id| room::is_primary(id))
            .expect("a primary room");
        assert_eq!(
            save_path("/var/lib/slate/slate-state.json", primary),
            Path::new("/var/lib/slate/slate-state.json")
        );
    }

    #[test]
    fn every_other_rooms_save_file_sits_beside_it() {
        for (id, _) in room::rooms().filter(|(id, _)| !room::is_primary(id)) {
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
        // front of it. Static segments outrank `{library}` in axum's router, so
        // this is belt and braces — but if that ever changed, a `rooms` library
        // would put the room list behind the secret the picker cannot offer.
        assert!(Library::named("rooms").is_none());
    }

    #[test]
    fn formats_are_recognised_by_their_magic_bytes() {
        assert_eq!(image_format(b"\x89PNG\r\n\x1a\n\x00\x00"), Some("png"));
        assert_eq!(image_format(&[0xff, 0xd8, 0xff, 0xe0, 0x00]), Some("jpg"));
        assert_eq!(image_format(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("webp"));
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
        // The calibration table is keyed on the URL this produces, so either of
        // these would orphan every map the DM has ever calibrated.
        assert_eq!(Library::Maps.prefix(), "");
        assert!(!Library::Maps.names_by_content());
    }

    #[test]
    fn a_replaced_portrait_is_a_new_copy_and_a_replaced_map_is_not() {
        // The asymmetry `Library::names_by_content` exists for, both halves of
        // it, so neither can be flipped without a test saying what it costs.
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
        assert_eq!(image_format(b""), None);
        assert_eq!(image_format(b"GIF89a"), None);
        assert_eq!(image_format(b"<!doctype html>"), None);
        assert_eq!(image_format(b"\x7fELF"), None);
        // A truncated RIFF header must not be read past the end.
        assert_eq!(image_format(b"RIFF\x00\x00\x00"), None);
        // RIFF, but a wave file rather than an image.
        assert_eq!(image_format(b"RIFF\x00\x00\x00\x00WAVEfmt "), None);
    }
}

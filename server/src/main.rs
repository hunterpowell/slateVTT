mod fog;
mod library;
mod protocol;
mod room;
mod store;
mod ws;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
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
const MAX_WS_MESSAGE_BYTES: usize = 16 * 1024;
const DM_SECRET_HEADER: &str = "x-slate-dm-secret";

/// Milestone 2 is one hardcoded room, so the handle lives directly in app
/// state. The `RwLock<HashMap<RoomId, RoomHandle>>` registry arrives with the
/// second room; until then it would guard a lookup with one possible answer.
#[derive(Clone)]
struct AppState {
    room: RoomHandle,
    /// The room holds its own copy for the WebSocket handshake. This one exists
    /// because an HTTP upload never reaches the room actor to be checked there.
    dm_secret: Arc<str>,
    uploads: Arc<Path>,
    /// The two libraries the DM picks out of. Neither is served directly — a
    /// pick copies into `uploads`, so there stays one kind of image URL.
    maps: Arc<Path>,
    portraits: Arc<Path>,
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
}

impl Library {
    fn dir(self, state: &AppState) -> Arc<Path> {
        match self {
            Self::Maps => state.maps.clone(),
            Self::Portraits => state.portraits.clone(),
        }
    }

    /// Named in the refusals, so a DM reading one knows which list it is about.
    fn noun(self) -> &'static str {
        match self {
            Self::Maps => "map",
            Self::Portraits => "portrait",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Maps => MAX_MAP_BYTES,
            Self::Portraits => MAX_TOKEN_BYTES,
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

    info!("DM link: http://{addr}/?dm={dm_secret}");

    let state_path = std::env::var("SLATE_STATE").unwrap_or_else(|_| "slate-state.json".to_owned());
    let store = store::Store::new(state_path.clone());

    // Startup, so a panic is the right answer here — and refusing to boot is the
    // safe answer. Starting a fresh room on top of a save we could not read
    // would destroy the group's game with the first token move.
    let saved = store
        .load()
        .await
        .unwrap_or_else(|err| panic!("could not load {state_path}: {err}"));

    match &saved {
        Some(_) => info!(%state_path, "restored the room from disk"),
        None => info!(%state_path, "no save found; starting from the built-in room"),
    }

    let uploads_dir = std::env::var("SLATE_UPLOADS").unwrap_or_else(|_| "uploads".to_owned());
    std::fs::create_dir_all(&uploads_dir)
        .unwrap_or_else(|err| panic!("could not create {uploads_dir}: {err}"));

    // Deliberately not created if either is absent. They hold files someone put
    // there on purpose, so an empty one conjured at boot would hide a mistyped
    // SLATE_MAPS or SLATE_PORTRAITS behind a picker that simply looks empty.
    let maps_dir = std::env::var("SLATE_MAPS").unwrap_or_else(|_| "../maps".to_owned());
    if !Path::new(&maps_dir).is_dir() {
        warn!(%maps_dir, "no map library there; the DM can still upload maps");
    }

    let portraits_dir =
        std::env::var("SLATE_PORTRAITS").unwrap_or_else(|_| "../portraits".to_owned());
    if !Path::new(&portraits_dir).is_dir() {
        warn!(%portraits_dir, "no portrait library there; the DM can still upload token art");
    }

    let room = room::spawn(dm_secret.clone(), saved, store);
    let state = AppState {
        room: room.clone(),
        dm_secret: dm_secret.into(),
        uploads: Path::new(&uploads_dir).into(),
        maps: Path::new(&maps_dir).into(),
        portraits: Path::new(&portraits_dir).into(),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        // One handler, two routes. A map and a token portrait are the same
        // operation — prove some bytes are an image, give them a name of ours —
        // and differ only in how large they are allowed to be.
        .route(
            "/api/map",
            post(upload_image).layer(DefaultBodyLimit::max(MAX_MAP_BYTES)),
        )
        .route(
            "/api/token",
            post(upload_image).layer(DefaultBodyLimit::max(MAX_TOKEN_BYTES)),
        )
        // Two libraries behind four routes that are each one line of their own.
        // The folder is the only thing that differs, so `Library` carries it and
        // the pair of handlers below is shared.
        .route("/api/maps", get(list_maps))
        .route("/api/maps/pick", post(pick_map))
        .route("/api/portraits", get(list_portraits))
        .route("/api/portraits/pick", post(pick_portrait))
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
            // Closing the room drops its per-client senders, which closes the
            // WebSockets and lets axum finish draining its active connections.
            if !room.shutdown().await {
                error!("room shutdown completed without saving its last change");
            }
        })
        .await
        .expect("server stopped unexpectedly");
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let client = ClientId(NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed));
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| ws::handle(socket, state.room, client))
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

/// Everything in a library, as paths to hand back to the matching pick route.
///
/// DM-only. No room state is involved, so this is not invariant 4 in the strict
/// sense, but a player reading off the names of every map the DM has prepared is
/// the same problem wearing a different hat.
async fn listing(
    state: &AppState,
    headers: &HeaderMap,
    which: Library,
) -> Result<Json<Listing>, (StatusCode, String)> {
    if !is_dm(state, headers) {
        return Err(not_the_dm(&format!("browse the {} library", which.noun())));
    }

    Ok(Json(Listing {
        files: library::list(&which.dir(state)).await,
    }))
}

async fn list_maps(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Listing>, (StatusCode, String)> {
    listing(&state, &headers, Library::Maps).await
}

async fn list_portraits(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Listing>, (StatusCode, String)> {
    listing(&state, &headers, Library::Portraits).await
}

#[derive(Deserialize)]
struct PickRequest {
    /// Relative to the library root, exactly as the listing reported it.
    path: String,
}

/// Copies a file out of a library into the uploads directory and reports the
/// URL it is now served at.
///
/// The response is deliberately the same shape `upload_image` returns: from the
/// client's point of view a pick and an upload differ only in where the bytes
/// came from, and both are followed by an ordinary `set_map` or `update_token`.
async fn pick(
    state: &AppState,
    headers: &HeaderMap,
    request: PickRequest,
    which: Library,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    let noun = which.noun();
    if !is_dm(state, headers) {
        return Err(not_the_dm(&format!("pick a {noun}")));
    }

    let dir = which.dir(state);
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

    // Sniffed rather than taken from the name, for the same reason an upload is:
    // the extension decides the `Content-Type` the copy is later served with, and
    // a file's name is not evidence of what is inside it.
    let Some(extension) = image_format(&bytes) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "that file is not a PNG, JPEG or WebP image".to_owned(),
        ));
    };

    let name = library::copy_name(&format!("{}{}", which.prefix(), pick.key), extension);
    let path = state.uploads.join(&name);

    // The name is derived from the source path, so an existing copy is already
    // this file. Rewriting it would only churn the disk and, worse, break the URL
    // the calibration table is keyed on if the write failed halfway.
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

async fn pick_map(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PickRequest>,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    pick(&state, &headers, request, Library::Maps).await
}

async fn pick_portrait(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PickRequest>,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    pick(&state, &headers, request, Library::Portraits).await
}

/// Stores an uploaded image — a map or a token's portrait — and reports the URL
/// it is now served at.
///
/// It deliberately does not touch the room. The DM's client follows this with a
/// `set_map` or a `create_token`, so the change that players actually see goes
/// through the same permission check, event pipeline and visibility filter as
/// everything else, rather than getting a private back door into `RoomState`.
async fn upload_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<StoredImage>, (StatusCode, String)> {
    if !is_dm(&state, &headers) {
        return Err(not_the_dm("upload images"));
    }

    let Some(extension) = image_format(&body) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "that has to be a PNG, JPEG or WebP image".to_owned(),
        ));
    };

    // The name is ours, never the client's: an uploaded filename is attacker
    // input and would have to be sanitised before it could touch a path.
    let name = format!("{}.{extension}", Uuid::new_v4().simple());
    let path = state.uploads.join(&name);

    fs::write(&path, &body).await.map_err(|err| {
        error!(%err, path = %path.display(), "could not store the uploaded image");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not store that image".to_owned(),
        )
    })?;

    info!(%name, bytes = body.len(), "stored an uploaded image");
    Ok(Json(StoredImage {
        url: format!("/uploads/{name}"),
    }))
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
    fn formats_are_recognised_by_their_magic_bytes() {
        assert_eq!(image_format(b"\x89PNG\r\n\x1a\n\x00\x00"), Some("png"));
        assert_eq!(image_format(&[0xff, 0xd8, 0xff, 0xe0, 0x00]), Some("jpg"));
        assert_eq!(image_format(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("webp"));
    }

    #[test]
    fn one_name_in_two_libraries_is_two_copies() {
        // Without the prefix these collide: the second pick finds the first
        // already written, skips the write, and hands back the wrong image.
        let as_map = library::copy_name(&format!("{}cave.png", Library::Maps.prefix()), "png");
        let as_portrait =
            library::copy_name(&format!("{}cave.png", Library::Portraits.prefix()), "png");
        assert_ne!(as_map, as_portrait);
    }

    #[test]
    fn a_picked_map_keeps_the_name_it_has_always_had() {
        // The calibration table is keyed on the URL this produces, so a change
        // here would orphan every map the DM has ever calibrated.
        assert_eq!(Library::Maps.prefix(), "");
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

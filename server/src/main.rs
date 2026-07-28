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
    /// The library the DM picks maps out of. Never served directly — a pick
    /// copies into `uploads`, so there stays one kind of map URL.
    maps: Arc<Path>,
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

    // Deliberately not created if it is absent. It holds maps someone put there
    // on purpose, so an empty one conjured at boot would hide a mistyped
    // SLATE_MAPS behind a picker that simply looks empty.
    let maps_dir = std::env::var("SLATE_MAPS").unwrap_or_else(|_| "../maps".to_owned());
    if !Path::new(&maps_dir).is_dir() {
        warn!(%maps_dir, "no map library there; the DM can still upload maps");
    }

    let room = room::spawn(dm_secret.clone(), saved, store);
    let state = AppState {
        room: room.clone(),
        dm_secret: dm_secret.into(),
        uploads: Path::new(&uploads_dir).into(),
        maps: Path::new(&maps_dir).into(),
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
        .route("/api/maps", get(list_maps))
        .route("/api/maps/pick", post(pick_map))
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
struct UploadedMap {
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
struct MapLibrary {
    maps: Vec<String>,
}

/// Everything in the map library, as paths to hand back to `pick_map`.
///
/// DM-only. No room state is involved, so this is not invariant 4 in the strict
/// sense, but a player reading off the names of every map the DM has prepared is
/// the same problem wearing a different hat.
async fn list_maps(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MapLibrary>, (StatusCode, String)> {
    if !is_dm(&state, &headers) {
        return Err(not_the_dm("browse the map library"));
    }

    Ok(Json(MapLibrary {
        maps: library::list(&state.maps).await,
    }))
}

#[derive(Deserialize)]
struct PickRequest {
    /// Relative to the library root, exactly as `list_maps` reported it.
    path: String,
}

/// Copies a map out of the library into the uploads directory and reports the
/// URL it is now served at.
///
/// The response is deliberately the same shape `upload_map` returns: from the
/// client's point of view a pick and an upload differ only in where the bytes
/// came from, and both are followed by an ordinary `set_map`.
async fn pick_map(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PickRequest>,
) -> Result<Json<UploadedMap>, (StatusCode, String)> {
    if !is_dm(&state, &headers) {
        return Err(not_the_dm("pick a map"));
    }

    let pick = library::resolve(&state.maps, &request.path).map_err(|err| match err {
        library::PickError::Rejected => {
            warn!(path = %request.path, "refused a map path that left the library");
            (
                StatusCode::BAD_REQUEST,
                "that is not a map in the library".to_owned(),
            )
        }
        library::PickError::Missing => (
            StatusCode::NOT_FOUND,
            "there is no such map in the library".to_owned(),
        ),
    })?;

    // Checked before the read rather than after, so a file that does not belong
    // in a library cannot be pulled into memory just to be rejected.
    let size = fs::metadata(&pick.path).await.map_err(|err| {
        error!(%err, path = %pick.path.display(), "could not read that map");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not read that map".to_owned(),
        )
    })?;
    if size.len() > MAX_MAP_BYTES as u64 {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "that map is too large".to_owned(),
        ));
    }

    let bytes = fs::read(&pick.path).await.map_err(|err| {
        error!(%err, path = %pick.path.display(), "could not read that map");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not read that map".to_owned(),
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

    let name = library::copy_name(&pick.key, extension);
    let path = state.uploads.join(&name);

    // The name is derived from the source path, so an existing copy is already
    // this map. Rewriting it would only churn the disk and, worse, break the URL
    // the calibration table is keyed on if the write failed halfway.
    if fs::metadata(&path).await.is_err() {
        fs::write(&path, &bytes).await.map_err(|err| {
            error!(%err, path = %path.display(), "could not copy that map");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not copy that map".to_owned(),
            )
        })?;
        info!(%name, source = %pick.key, bytes = bytes.len(), "copied a map out of the library");
    }

    Ok(Json(UploadedMap {
        url: format!("/uploads/{name}"),
    }))
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
) -> Result<Json<UploadedMap>, (StatusCode, String)> {
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
    Ok(Json(UploadedMap {
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

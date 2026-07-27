mod protocol;
mod room;
mod store;
mod ws;

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
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

    let state = AppState {
        room: room::spawn(dm_secret.clone(), saved, store),
        dm_secret: dm_secret.into(),
        uploads: Path::new(&uploads_dir).into(),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/map", post(upload_map).layer(DefaultBodyLimit::max(MAX_MAP_BYTES)))
        .nest_service("/uploads", ServeDir::new(&uploads_dir))
        .fallback_service(ServeDir::new(&client_dir).append_index_html_on_directories(true))
        .with_state(state);

    // Startup failures are fatal and there is nothing to recover to, so this is
    // the one place a panic is the right answer.
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|err| panic!("could not bind {addr}: {err}"));

    info!(%addr, %client_dir, %uploads_dir, "slate listening");

    axum::serve(listener, app).await.expect("server stopped unexpectedly");
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let client = ClientId(NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed));
    ws.on_upgrade(move |socket| ws::handle(socket, state.room, client))
}

#[derive(Serialize)]
struct UploadedMap {
    url: String,
}

/// Stores an uploaded image and reports the URL it is now served at.
///
/// It deliberately does not touch the room. The DM's client follows this with a
/// `set_map`, so the change that players actually see goes through the same
/// permission check, event pipeline and visibility filter as everything else,
/// rather than getting a private back door into `RoomState`.
async fn upload_map(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<UploadedMap>, (StatusCode, String)> {
    let offered = headers.get(DM_SECRET_HEADER).and_then(|value| value.to_str().ok());
    if offered != Some(state.dm_secret.as_ref()) {
        warn!("rejected a map upload with a bad DM secret");
        return Err((StatusCode::FORBIDDEN, "only the DM can change the map".to_owned()));
    }

    let Some(extension) = image_format(&body) else {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "a map must be a PNG, JPEG or WebP image".to_owned(),
        ));
    };

    // The name is ours, never the client's: an uploaded filename is attacker
    // input and would have to be sanitised before it could touch a path.
    let name = format!("{}.{extension}", Uuid::new_v4().simple());
    let path = state.uploads.join(&name);

    fs::write(&path, &body).await.map_err(|err| {
        error!(%err, path = %path.display(), "could not store the uploaded map");
        (StatusCode::INTERNAL_SERVER_ERROR, "could not store that map".to_owned())
    })?;

    info!(%name, bytes = body.len(), "stored an uploaded map");
    Ok(Json(UploadedMap { url: format!("/uploads/{name}") }))
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

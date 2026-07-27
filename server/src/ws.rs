//! One WebSocket connection: split the socket, run a task on each half.
//!
//! recv task  — WS stream -> deserialize -> push (ClientId, ClientMsg) to the room
//! send task  — this client's mpsc::Receiver -> serialize -> WS sink

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, error, warn};

use crate::protocol::{ClientId, ClientMsg, ServerMsg};
use crate::room::{RoomCmd, RoomHandle, CLIENT_MAILBOX};

pub async fn handle(socket: WebSocket, room: RoomHandle, client: ClientId) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMsg>(CLIENT_MAILBOX);

    // Register before spawning anything, so the room can answer the client's
    // Hello the moment it arrives.
    if !room.send(RoomCmd::Connected { client, out: out_tx }).await {
        return;
    }

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let json = match serde_json::to_string(&msg) {
                Ok(json) => json,
                Err(err) => {
                    // Our own type failed to serialize: a bug, but not this
                    // connection's fault, so keep the socket alive.
                    error!(%err, "failed to serialize ServerMsg");
                    continue;
                }
            };
            if sink.send(Message::text(json)).await.is_err() {
                break;
            }
        }
    });

    let recv_room = room.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(frame) = stream.next().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(err) => {
                    debug!(?client, %err, "websocket read failed");
                    break;
                }
            };

            let text = match frame {
                Message::Text(text) => text,
                Message::Close(_) => break,
                // Ping/Pong are answered by axum; we send no binary frames.
                _ => continue,
            };

            match serde_json::from_str::<ClientMsg>(&text) {
                Ok(msg) => {
                    if !recv_room.send(RoomCmd::Msg { client, msg }).await {
                        break;
                    }
                }
                // A frame we cannot parse is not grounds for hanging up; log it
                // and keep reading.
                Err(err) => warn!(?client, %err, "discarding unparseable frame"),
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    room.send(RoomCmd::Disconnected { client }).await;
}

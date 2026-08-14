//! One WebSocket connection: split the socket, run a task on each half.
//!
//! recv task  — WS stream -> deserialize -> push (ClientId, ClientMsg) to the room
//! send task  — this client's mpsc::Receiver -> serialize -> WS sink, and a ping
//!              on a timer so a quiet board does not look like a dead connection

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;
use tracing::{debug, error, warn};

use crate::protocol::{ClientId, ClientMsg, ServerMsg};
use crate::room::{CLIENT_MAILBOX, RoomCmd, RoomHandle};

/// How often an idle socket is pinged.
///
/// Nothing crosses a quiet board in either direction, and a proxy that sees no
/// traffic for long enough closes the connection — which through a Cloudflare
/// Tunnel left a DM planning between fights refreshing the page. On loopback
/// nothing did that, which is why this was not needed until Slate was hosted.
///
/// A browser answers a ping at the protocol level, so this costs the client
/// nothing and adds no message to the wire format. Well under any plausible
/// idle timeout rather than tuned to a particular one.
const KEEPALIVE: Duration = Duration::from_secs(30);

pub async fn handle(socket: WebSocket, room: RoomHandle, client: ClientId) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMsg>(CLIENT_MAILBOX);

    // Register before spawning anything, so the room can answer the client's
    // Hello the moment it arrives.
    if !room
        .send(RoomCmd::Connected {
            client,
            out: out_tx,
        })
        .await
    {
        return;
    }

    let mut send_task = tokio::spawn(async move {
        let mut keepalive = tokio::time::interval(KEEPALIVE);
        // A stalled sink must not bank ticks and then fire a burst of pings at
        // whatever unblocked it.
        keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // The first tick is immediate, so spend it here rather than opening
        // every connection with a ping.
        keepalive.tick().await;

        loop {
            let frame = tokio::select! {
                msg = out_rx.recv() => match msg {
                    Some(msg) => match serde_json::to_string(&msg) {
                        Ok(json) => Message::text(json),
                        Err(err) => {
                            // Our own type failed to serialize: a bug, but not
                            // this connection's fault, so keep the socket alive.
                            error!(%err, "failed to serialize ServerMsg");
                            continue;
                        }
                    },
                    // The room dropped this client's sender.
                    None => break,
                },
                _ = keepalive.tick() => Message::Ping(Bytes::new()),
            };

            if sink.send(frame).await.is_err() {
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
                // A client's ping is answered by axum, and the pong answering
                // ours arrives here with nothing to do about it. We send no
                // binary frames.
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

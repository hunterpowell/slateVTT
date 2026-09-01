//! What `/api/status` is told about a room. See `client/status/README.md`.
//!
//! **The status page is an ops window and not a second board**, which is what
//! most of these assert: it counts what the box is holding rather than what any
//! one client may see, and it is behind its own credential precisely so that it
//! can. The one thing it must never do is invent a second answer to a question
//! the room already answers — `here` is `RoomState::here`, not a copy of it.

use super::*;

fn player(slot: &str) -> Owner {
    Owner::Player(PlayerId::new(slot))
}

/// A room whose writes to disk are going fine, which is what every
/// assertion in this file that is not about the disk wants.
fn healthy() -> SaveHealth {
    SaveHealth::default()
}

/// A save path no other test will collide with.
fn scratch(what: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "slate-status-{what}-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ))
}

// --- what a room reports --------------------------------------------------

#[test]
fn here_is_the_presence_strips_answer_and_not_a_second_one() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    // Bound, not dropped: a dropped receiver closes the channel, and the next
    // dispatch evicts the client for a wedged socket. Every connection in this
    // file has to outlive the assertion it is part of.
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    // What the strip was actually sent, taken off the wire rather than
    // recomputed — if these two ever disagree, one of them is lying to somebody.
    let strip = drain_all(&mut dm)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::Presence { here } => Some(here),
            _ => None,
        })
        .next_back()
        .expect("a presence frame");

    assert_eq!(state.status(false, &healthy()).here, strip);
    assert_eq!(
        state.status(false, &healthy()).here,
        vec![Owner::Dm, player("saelyn")]
    );
}

#[test]
fn sockets_counts_tabs_where_here_counts_people() {
    let mut state = room();
    let _laptop = join_as_player(&mut state, ClientId(1), "saelyn");
    // The same person on a laptop and a phone. `here` deduplicates them by
    // design; the point of `sockets` is that this is the one fact it cannot say.
    let _phone = join_as_player(&mut state, ClientId(2), "saelyn");

    let status = state.status(false, &healthy());
    assert_eq!(status.here, vec![player("saelyn")], "one person");
    assert_eq!(status.sockets, 2, "two tabs");
}

#[test]
fn a_socket_still_on_the_picker_is_a_socket() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    // Connected, has not said who it is. It is holding a connection open and
    // costing the box the same as any other, so `sockets` counts it — and it
    // belongs to nobody, so `here` cannot.
    let _undecided = connect(&mut state, ClientId(2));

    let status = state.status(false, &healthy());
    assert_eq!(status.here, vec![Owner::Dm]);
    assert_eq!(status.sockets, 2);
}

#[test]
fn tokens_are_counted_whole_rather_than_as_the_table_sees_them() {
    let mut state = room();
    let dm = ClientId(1);
    let _seat = join_as_dm(&mut state, dm);
    let before = state.status(false, &healthy()).tokens;

    state.handle(dm, create_hidden("ogre"));

    // Deliberate: this is the DM's own ops view, behind its own key, so it
    // counts what the room is holding. Filtering it through `unseen_by_table`
    // would make the number answer a question nobody asked it.
    assert_eq!(
        state.status(false, &healthy()).tokens,
        before + 1,
        "a hidden token is still a token the room is holding"
    );
}

#[test]
fn unsaved_is_the_callers_to_supply() {
    // The debounce deadline lives in `run` and not on the state, which is the
    // whole reason this argument exists. Cheap to assert and it records the seam.
    let state = room();
    assert!(!state.status(false, &healthy()).unsaved);
    assert!(state.status(true, &healthy()).unsaved);
}

// --- how the writes to disk are going ------------------------------------

#[tokio::test]
async fn a_failing_save_is_not_the_same_as_a_pending_one() {
    // The defect this pair exists for. A save that keeps failing leaves
    // `save_at` set exactly as a change waiting out the debounce does, so on
    // the deadline alone a dying card reads as a healthy write two seconds old
    // — and the retry loop is silent apart from a line in the journal.
    let state = room();
    let mut health = SaveHealth::default();

    // A store that cannot possibly write: the parent of its path is a file, so
    // the `create_dir_all` inside `save` fails before any bytes are attempted.
    let blocker = scratch("blocked");
    std::fs::write(&blocker, b"not a directory").expect("the blocking file");
    let store = Store::new(blocker.join("room.json"));

    assert!(
        flush(&state, &store, &mut health).await.is_some(),
        "a failed save schedules a retry"
    );
    assert!(health.failing);
    assert_eq!(health.last_ok_unix, None);

    let status = state.status(true, &health);
    assert!(status.unsaved, "the change is genuinely not on disk");
    assert!(
        status.saves_failing,
        "and the page can tell that from an ordinary pending write"
    );
}

#[tokio::test]
async fn a_good_save_clears_the_flag_and_stamps_the_time() {
    // The flag outlives one attempt on purpose, so something has to put it
    // down again. Without this a room would report failing writes forever
    // after one transient error.
    let state = room();
    let mut health = SaveHealth {
        failing: true,
        last_ok_unix: None,
    };
    let store = Store::new(scratch("recovers"));

    assert!(flush(&state, &store, &mut health).await.is_none());
    assert!(!health.failing, "a good write puts the flag down");
    assert!(
        health.last_ok_unix.is_some(),
        "and says when, so the page can say how much is at risk next time"
    );
    assert!(!state.status(false, &health).saves_failing);
}

#[test]
fn a_room_that_has_never_saved_is_not_a_room_in_trouble() {
    // A quiet room is entitled to have written nothing this run, so `None`
    // here must not read as an alarm anywhere downstream.
    let status = room().status(false, &healthy());
    assert_eq!(status.last_saved_unix, None);
    assert!(!status.saves_failing);
    assert!(!status.unsaved);
}

// --- asking the actor -----------------------------------------------------

#[tokio::test]
async fn the_actor_answers_a_status_and_carries_on() {
    let room = spawn(
        SECRET.to_owned(),
        roster_from(&ROSTER),
        None,
        Store::new(scratch("actor")),
        true,
    );

    let first = room.status().await.expect("a live room answers");
    assert_eq!(first.sockets, 0);
    assert!(!first.unsaved, "a freshly booted room has nothing pending");

    // The point of "and carries on": `Shutdown` returns from the loop and this
    // one must not. A second answer is the only way to see the difference.
    let second = room.status().await.expect("still alive");
    assert_eq!(second.tokens, first.tokens);
}

#[tokio::test]
async fn a_room_that_is_gone_does_not_answer() {
    let room = spawn(
        SECRET.to_owned(),
        roster_from(&ROSTER),
        None,
        Store::new(scratch("gone")),
        true,
    );
    assert!(room.shutdown().await, "clean room, nothing to flush");

    // The reachable half of "did not answer" — the other half is a wedged task,
    // which only the caller's timeout can catch. Both have to arrive as `None`
    // or the status page has no way to say a room is in trouble.
    assert!(
        room.status().await.is_none(),
        "a closed channel is not an answer"
    );
}

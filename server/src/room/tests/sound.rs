//! The room's music.
//!
//! One looping track the DM picks, playing on every screen that asked for it.
//! These tests hold down two things: that it is the backdrop's twin on the wire,
//! and that it is *not* the backdrop underneath — it is memory only, so it never
//! reaches the disk and an undo can never reach it. See `docs/sound.md`.

use super::*;

const AMBIENT: &str = "/uploads/track-ambient-4b1e77c2.ogg";
const BOSS: &str = "/uploads/track-boss-1a2b3c4d.ogg";

fn play(url: Option<&str>) -> ClientMsg {
    ClientMsg::SetAudio {
        url: url.map(str::to_owned),
    }
}

#[test]
fn only_the_dm_can_choose_the_music() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    state.handle(ClientId(1), play(Some(AMBIENT)));

    assert!(
        state.audio.is_none(),
        "a player started music on five other people's speakers"
    );
    // And the refusal is the only thing they got back, rather than a frame
    // describing a room that did not change.
    assert!(matches!(
        drain(&mut saelyn).as_slice(),
        [ServerMsg::Error { .. }]
    ));
}

#[test]
fn the_music_reaches_the_table_and_the_dm_alike() {
    // `BackdropChanged`'s rule: who may put music on is a permission, and which
    // track it is is not a secret — everyone can hear it.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), play(Some(AMBIENT)));

    // Echoed to the DM who sent it, like the backdrop beside it: nothing here is
    // predicted locally, so this frame is how their own panel settles.
    assert!(
        matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::AudioChanged { url: Some(url) }] if url == AMBIENT
        ),
        "the DM was not told their own pick landed"
    );
    assert!(
        matches!(
            drain(&mut saelyn).as_slice(),
            [ServerMsg::AudioChanged { url: Some(url) }] if url == AMBIENT
        ),
        "the table was not sent the track"
    );
}

#[test]
fn the_music_is_in_every_snapshot() {
    // Invariant 3 on a field with no filter — and here it is also the reconnect
    // assertion, because a reconnect is another join. A dropped socket reloads
    // the page, so without this a player who blinked comes back silent while
    // everyone else is still listening.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), play(Some(AMBIENT)));

    assert_eq!(
        state.snapshot_for(&Identity::Dm).audio.as_deref(),
        Some(AMBIENT)
    );
    assert_eq!(
        state.snapshot_for(&as_player("saelyn")).audio.as_deref(),
        Some(AMBIENT)
    );
}

#[test]
fn choosing_the_music_is_not_a_step() {
    // `persists` and `undid` asserted directly, the way `dice.rs` asserts them
    // for a throw. If either flips, the DM is offered an undo whose label says
    // "the music" and whose press does nothing.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let depth = state.undo.len();

    assert!(
        !state.handle(ClientId(1), play(Some(AMBIENT))),
        "the music is session memory; it must never mark the room dirty"
    );
    assert_eq!(state.undo.len(), depth, "a track was a step to go back to");
    // `drain_all` rather than `drain`: the point is that no `UndoChanged` rode
    // along, which the filtered version would hide.
    assert!(
        !drain_all(&mut dm)
            .iter()
            .any(|msg| matches!(msg, ServerMsg::UndoChanged { .. })),
        "the undo button was relabelled by somebody putting music on"
    );
}

#[test]
fn an_undo_does_not_change_the_music() {
    // **The test the persistence decision exists for.** Re-assigning an
    // `<audio>` source restarts the track, so a restore that swept the music
    // back to a previous pick would restart it mid-scene — the DM undoes a wall
    // and the boss theme starts again.
    //
    // Note what makes this pass: `audio` is not on `Saved`, so `adopt` never
    // touches it. The scratchpad and the colours each needed two lines to reach
    // the same place; this needed none.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), play(Some(BOSS)));
    state.handle(ClientId(1), ClientMsg::ClearShapes);
    let _ = drain_all(&mut dm);

    state.handle(ClientId(1), ClientMsg::Undo);

    assert_eq!(
        state.audio.as_deref(),
        Some(BOSS),
        "an undo changed what the room was playing"
    );
    // And it is not merely unchanged — nobody was told it changed. A frame
    // carrying the same URL is what would restart the track on every client.
    assert!(
        !drain_all(&mut dm)
            .iter()
            .any(|msg| matches!(msg, ServerMsg::AudioChanged { .. })),
        "an undo re-announced the music, which restarts it on every client"
    );
}

#[test]
fn the_music_is_not_in_the_save_file() {
    // **The test that holds `store.rs` still.** The day somebody adds `audio`
    // to `Saved` for the look of the thing, this fails and says why — and the
    // undo test above starts failing beside it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), play(Some(AMBIENT)));

    let json = serde_json::to_string(&state.to_saved()).expect("a room serializes");
    assert!(!json.contains(AMBIENT), "the music reached the save file");
}

#[test]
fn a_track_url_is_bounded_like_a_map_url() {
    // The only bound there is to apply. The picker only ever sends a path the
    // pick route just handed back, so this is about a hostile frame.
    let mut state = room();
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);

    assert!(state.check(dm, &play(Some(&"x".repeat(513)))).is_err());
    assert!(state.check(dm, &play(Some(""))).is_err());
    // And `None` is not an empty URL — it is silence.
    assert!(state.check(dm, &play(None)).is_ok());
}

#[test]
fn the_music_travels_alone() {
    // The boundary sentence as an assertion. Music is not on the board, so
    // nothing on the board is swept: a future refactor routing this through
    // `SetMap` — or teaching it to pause on a map load — fails here.
    let mut state = fog_room(60.0);
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    state.handle(dm, trace(&[(0.0, 0.0), (64.0, 0.0), (64.0, 64.0)], false));
    let walls = state.walls.len();
    let _ = drain_all(&mut dm_rx);

    state.handle(dm, play(Some(BOSS)));

    assert_eq!(state.walls.len(), walls, "putting music on swept the walls");
    let sent = drain_all(&mut dm_rx);
    assert!(
        matches!(sent.as_slice(), [ServerMsg::AudioChanged { .. }]),
        "the music did not travel alone: {sent:?}"
    );
}

#[test]
fn stopping_the_music_is_a_frame_of_its_own() {
    // `None` is a destination like any other and the table is owed it: a room
    // where the DM can start music but not stop it on six other machines is
    // worse than one with no music at all.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), play(Some(AMBIENT)));
    let _ = drain(&mut dm);
    let _ = drain(&mut saelyn);

    state.handle(ClientId(1), play(None));

    assert!(state.audio.is_none());
    assert!(matches!(
        drain(&mut saelyn).as_slice(),
        [ServerMsg::AudioChanged { url: None }]
    ));
}

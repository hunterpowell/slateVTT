//! Tracing walls and swinging doors. See `docs/walls.md`.

use super::*;

/// A three-corner run: two segments meeting at a right angle.
fn a_corner() -> ClientMsg {
    trace(&[(0.0, 0.0), (128.0, 0.0), (128.0, 128.0)], false)
}

fn wall_ids(state: &RoomState) -> Vec<WallId> {
    state.walls.iter().map(|w| w.id.clone()).collect()
}

/// What is traced on the map the DM is preparing. Empty for an empty slot,
/// which is what an untraced staged map looks like anyway.
fn staged_walls(state: &RoomState) -> &[Wall] {
    state.walls_in(true)
}

// --- walls and doors ------------------------------------------------------

#[test]
fn a_traced_run_becomes_one_segment_per_gap_between_its_corners() {
    // The whole point of the milestone: a two-hundred-segment dungeon is one
    // command per run rather than one per segment.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), a_corner());

    assert_eq!(state.walls.len(), 2);
    let first = state.walls.first().expect("the first segment");
    let second = state.walls.get(1).expect("the second segment");
    assert_eq!(first.from, Px { x: 0.0, y: 0.0 });
    assert_eq!(first.to, Px { x: 128.0, y: 0.0 });
    // Consecutive segments share a corner: the run is a polyline, and the
    // gap between two of them would be a gap fog leaks through.
    assert_eq!(second.from, first.to);
    assert_eq!(second.to, Px { x: 128.0, y: 128.0 });
    // The ids are the server's to invent, and distinct — erasing one bad
    // segment of a long trace is the reason they exist at all.
    assert_ne!(first.id, second.id);
    assert!(!first.id.0.is_empty());
}

#[test]
fn a_run_of_doors_is_traced_shut() {
    // A door the DM has to close after drawing it is a door they forget to
    // close, and a dungeon's doors are shut until somebody opens them.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), trace(&[(0.0, 0.0), (64.0, 0.0)], true));

    assert_eq!(state.walls.first().expect("the door").door(), Some(false));
}

#[test]
fn only_the_dm_may_trace_erase_or_open_anything() {
    // Every wall command at once: unlike the drawings, there is no
    // per-item permission underneath — the walls are all the DM's.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (64.0, 0.0)], true));
    let door = state.walls.first().expect("the door").id.clone();

    for msg in [a_corner(), erase(door.clone()), swing(door), clear_walls()] {
        assert!(
            state.check(ClientId(2), &msg).is_err(),
            "a player got as far as {msg:?}"
        );
    }
    assert_eq!(state.walls.len(), 1, "and none of it happened");
}

#[test]
fn a_player_is_never_sent_a_wall_or_told_one_exists() {
    // Invariant 4 at its plainest. Players infer the geometry from the edges
    // of the fog; the floor plan itself is not theirs to hold, and a frame
    // they cannot use still tells them the DM just did something.
    let mut state = room();
    let dm_client = ClientId(1);
    let _dm = join_as_dm(&mut state, dm_client);
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut saelyn);

    state.handle(dm_client, a_corner());

    let dm_view = state.snapshot_for(&Identity::Dm);
    let player_view = state.snapshot_for(&Identity::Player(PlayerId::new("saelyn")));
    assert_eq!(dm_view.walls.len(), 2);
    assert!(
        player_view.walls.is_empty(),
        "empty is both 'nothing traced' and 'not the DM'"
    );
    assert!(
        saelyn.try_recv().is_err(),
        "not even an empty walls_changed: the frame itself is news"
    );
    assert!(
        state
            .message_for(
                ClientId(1),
                dm_client,
                &Event::WallsChanged { staged: false }
            )
            .is_some(),
        "the DM is the one recipient it has"
    );
}

#[test]
fn a_door_swings_both_ways_and_masonry_does_not() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (64.0, 0.0)], true));
    state.handle(ClientId(1), a_corner());
    let door = state.walls.first().expect("the door").id.clone();
    let solid = state.walls.get(1).expect("the masonry").id.clone();

    state.handle(ClientId(1), swing(door.clone()));
    assert_eq!(state.walls.first().expect("the door").door(), Some(true));
    state.handle(ClientId(1), swing(door));
    assert_eq!(state.walls.first().expect("the door").door(), Some(false));

    // Refused rather than ignored: it means the client and the room disagree
    // about what that segment is, and doing nothing quietly hides that.
    let err = state
        .check(ClientId(1), &swing(solid))
        .expect_err("masonry does not open");
    assert!(err.contains("not a door"), "{err}");
}

#[test]
fn one_bad_segment_can_be_erased_without_redrawing_the_run() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), a_corner());
    let [first, second] = wall_ids(&state).try_into().expect("two segments");

    state.handle(ClientId(1), erase(first));

    assert_eq!(wall_ids(&state), vec![second]);
}

#[test]
fn erasing_a_wall_that_is_already_gone_is_refused_not_ignored() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    let err = state
        .check(ClientId(1), &erase(WallId("nothing".to_owned())))
        .expect_err("refused");
    assert!(err.contains("already gone"), "{err}");
}

#[test]
fn a_new_map_clears_the_walls_and_a_recalibration_does_not() {
    // The arm that gets missed, for the third feature in a row. A wall
    // traces the art of *this* image, so a new one throws it away — and
    // correcting the grid does not touch the art at all, which is exactly
    // the order the DM does these two things in.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), a_corner());

    state.handle(ClientId(1), set_map("/assets/map.png", 80.0, 3.0, 4.0));
    assert_eq!(state.walls.len(), 2, "recalibrating leaves the tracing");

    state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 0.0, 0.0));
    assert!(state.walls.is_empty(), "a different dungeon");
}

#[test]
fn staging_leaves_the_walls_alone_and_promoting_replaces_them() {
    // Staging a map is not touching the board, so the masonry the table is
    // playing on stays where it is. A promote *is* a load, so the board's own
    // walls go — and what lands in their place is what was traced on the map
    // that arrived, which is milestone 20 rather than a sweep.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), a_corner());

    stage(&mut state, ClientId(1), "/uploads/next.webp");
    assert_eq!(state.walls.len(), 2, "the board is untouched by staging");

    state.handle(ClientId(1), staged(trace(&[(0.0, 0.0), (64.0, 0.0)], true)));
    assert_eq!(
        state.walls.len(),
        2,
        "and by anything traced on the staged one"
    );

    state.handle(ClientId(1), ClientMsg::PromoteStaged);
    assert_eq!(
        state.walls.len(),
        1,
        "the board's two are gone and the staged one's arrived"
    );
    assert_eq!(
        state.walls.first().map(|w| w.door()),
        Some(Some(false)),
        "as the door it was traced as, not as masonry"
    );
    assert!(
        state.staged.is_none(),
        "and the slot it came out of is empty"
    );
}

#[test]
fn a_staged_door_promotes_however_the_dm_left_it() {
    // A door is traced shut on both boards, because a door the DM has to close
    // after drawing it is one they will forget to close. Swinging a staged one
    // is not play — nobody is playing on that map yet — it is the DM saying
    // this room is already ajar when the party walks in.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage(&mut state, ClientId(1), "/uploads/next.webp");
    state.handle(ClientId(1), staged(trace(&[(0.0, 0.0), (64.0, 0.0)], true)));

    let door = staged_walls(&state).first().expect("the door").id.clone();
    assert_eq!(
        staged_walls(&state).first().map(|w| w.door()),
        Some(Some(false)),
        "traced shut, exactly as a live one is"
    );

    state.handle(ClientId(1), staged(swing(door)));
    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    assert_eq!(
        state.walls.first().map(|w| w.door()),
        Some(Some(true)),
        "the party finds it open, because that is how it was left"
    );
}

#[test]
fn a_wall_command_names_a_slot_and_reaches_only_that_one() {
    // The `SetMap` / `MoveToken` / `CreateToken` pattern for the fourth time.
    // The ids are UUIDs, so a lookup that searched both lists would find this
    // segment either way — and would erase the wrong dungeon's masonry on a
    // frame the DM sent while looking at the other board.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), a_corner());
    stage(&mut state, ClientId(1), "/uploads/next.webp");
    state.handle(
        ClientId(1),
        staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)),
    );

    let live = state.walls.first().expect("live masonry").id.clone();
    let planned = staged_walls(&state).first().expect("staged").id.clone();

    // Each id is a stranger to the other slot, which is what the flag buys.
    assert!(
        state.check(ClientId(1), &erase(planned.clone())).is_err(),
        "a staged wall is not on the live board"
    );
    assert!(
        state.check(ClientId(1), &staged(erase(live))).is_err(),
        "and a live wall is not on the staged one"
    );

    state.handle(ClientId(1), staged(erase(planned)));
    assert!(staged_walls(&state).is_empty());
    assert_eq!(
        state.walls.len(),
        2,
        "the board never heard about any of it"
    );
}

#[test]
fn tracing_a_slot_with_no_map_in_it_is_refused() {
    // The rule `CreateToken` and a staged `MoveToken` already follow, and it is
    // the slot being empty rather than the server learning about preview.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for msg in [
        staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)),
        staged(clear_walls()),
    ] {
        let err = state
            .check(ClientId(1), &msg)
            .expect_err("nothing is staged to trace on");
        assert!(err.contains("no map"), "{err}");
    }
}

#[test]
fn a_player_is_never_sent_a_staged_wall_either() {
    // Staging added no visibility surface, and this is the assertion that says
    // so: the same one line that withholds a live wall withholds this, and a
    // player is not told the staged board changed at all.
    let mut state = room();
    let dm = ClientId(1);
    let dm_client = ClientId(1);
    let mut _dm_rx = join_as_dm(&mut state, dm);
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    stage(&mut state, dm, "/uploads/next.webp");
    state.handle(dm, staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)));

    assert!(
        state.snapshot_for(&as_player("saelyn")).staged.is_none(),
        "the whole slot, map and masonry together, leaves by one door"
    );
    assert!(
        state
            .message_for(
                ClientId(2),
                dm_client,
                &Event::WallsChanged { staged: true }
            )
            .is_none(),
        "not even an empty list: the frame itself is news"
    );
    // Drain: the two frames above were dispatched to a player who should have
    // received neither.
    assert!(
        saelyn.try_recv().is_err(),
        "a player was sent something about the next dungeon"
    );
}

#[test]
fn a_map_load_with_nothing_traced_announces_nothing() {
    // The gate on `sweep_board`, which is the same gate the initiative panel
    // uses. An unconditional frame on every map load is a message about a
    // board that had nothing on it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    let events = state.apply(ClientId(1), set_map("/uploads/cave.webp", 70.0, 0.0, 0.0));

    assert!(
        !events
            .iter()
            .any(|e| matches!(e, Event::WallsChanged { .. } | Event::ShapesChanged)),
        "swept a board that was already empty: {events:?}"
    );
}

#[test]
fn a_run_needs_two_corners_and_cannot_run_forever() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    // One click is a run that was never finished; the client does not send
    // it, and it would store nothing if it did.
    assert!(
        state
            .check(ClientId(1), &trace(&[(0.0, 0.0)], false))
            .is_err()
    );

    let too_many: Vec<(f32, f32)> = (0..=MAX_WALL_POINTS as i32)
        .map(|i| (i as f32 * 64.0, 0.0))
        .collect();
    assert!(state.check(ClientId(1), &trace(&too_many, false)).is_err());
}

#[test]
fn a_map_cannot_be_filled_with_walls_without_limit() {
    // `apply` rather than `handle`, like the drawings cap and for the same
    // reason: the rule is in `check`, and pushing this many through the
    // whole pipeline only fills the test's mailbox.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    // Each run is one segment, so this reaches the cap exactly.
    for i in 0..MAX_WALLS {
        state.apply(
            ClientId(1),
            trace(&[(i as f32, 0.0), (i as f32, 64.0)], false),
        );
    }
    assert_eq!(state.walls.len(), MAX_WALLS);

    // And the check counts segments the run *would* add, not commands.
    assert!(
        state
            .check(ClientId(1), &trace(&[(0.0, 0.0), (64.0, 0.0)], false))
            .is_err()
    );
}

#[test]
fn a_corner_off_the_map_is_refused() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for bad in [f32::NAN, f32::INFINITY, MAX_MAP_PX * 2.0] {
        assert!(
            state
                .check(ClientId(1), &trace(&[(0.0, 0.0), (bad, 0.0)], false))
                .is_err(),
            "{bad} should be refused"
        );
    }
    // A corner a shade outside the image is not: a DM tracing right up to
    // the edge should not have a click refused for landing a pixel over it.
    assert!(
        state
            .check(ClientId(1), &trace(&[(-4.0, -4.0), (64.0, 0.0)], false))
            .is_ok()
    );
}

#[test]
fn a_traced_dungeon_survives_the_save_file() {
    // The one thing on `Saved` that would make this feature unusable if it
    // were not persisted: the map is still on the board next week.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), a_corner());
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (0.0, 64.0)], true));
    let door = state.walls.last().expect("the door").id.clone();
    state.handle(ClientId(1), swing(door.clone()));

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = RoomState::restored(saved, SECRET.to_owned());

    assert_eq!(restored.walls.len(), 3);
    let reopened = restored.walls.last().expect("the door");
    assert_eq!(reopened.id, door);
    assert_eq!(reopened.door(), Some(true), "an open door stays open");
    assert_eq!(reopened.from, Px { x: 0.0, y: 0.0 });
}

#[test]
fn a_room_saved_before_walls_existed_still_loads() {
    // Invariant 2 again, on this milestone's field. And the default matters
    // beyond loading: a segment that defaulted to an open door would quietly
    // stop blocking anything the moment fog arrives.
    let saved: Saved = serde_json::from_str("{}").expect("an empty room decodes");
    let restored = RoomState::restored(saved, SECRET.to_owned());
    assert!(restored.walls.is_empty());
    assert_eq!(WallKind::default(), WallKind::Solid);
}

#[test]
fn a_wall_is_worth_saving() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(state.handle(ClientId(1), a_corner()));
}

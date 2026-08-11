//! Loading, recalibrating, staging and promoting a map. See `docs/maps.md`.

use super::*;

/// The same command again, building the token on the map the DM is
/// preparing rather than on the board.
fn create_staged(name: &str) -> ClientMsg {
    with(create(name, 1.0, Owner::Dm), |_, staged| *staged = true)
}

fn set_color(color: &str) -> ClientMsg {
    ClientMsg::SetMap {
        url: "/assets/map.png".to_owned(),
        grid_px: 64.0,
        offset_x: 0.0,
        offset_y: 0.0,
        grid_color: color.to_owned(),
        play_area: None,
        fog: UNFOGGED.0,
        vision_ft: UNFOGGED.1,
        staged: false,
    }
}

fn set_area(area: Option<Rect>) -> ClientMsg {
    ClientMsg::SetMap {
        url: "/assets/map.png".to_owned(),
        grid_px: 64.0,
        offset_x: 0.0,
        offset_y: 0.0,
        grid_color: "#ffffff52".to_owned(),
        play_area: area,
        fog: UNFOGGED.0,
        vision_ft: UNFOGGED.1,
        staged: false,
    }
}

/// A `set_map` with every calibrated field distinct, so a test can tell
/// which of two calibrations came back.
fn calibrate(url: &str, grid_px: f32, offset: f32, color: &str) -> ClientMsg {
    ClientMsg::SetMap {
        url: url.to_owned(),
        grid_px,
        offset_x: offset,
        offset_y: -offset,
        grid_color: color.to_owned(),
        play_area: rect(offset, offset, grid_px * 10.0, grid_px * 8.0),
        fog: UNFOGGED.0,
        vision_ft: UNFOGGED.1,
        staged: false,
    }
}

/// A room with a map staged and the DM's echo of that already drained.
fn staged_room(dm: ClientId) -> (RoomState, mpsc::Receiver<ServerMsg>) {
    let mut state = room();
    let mut rx = join_as_dm(&mut state, dm);
    stage(&mut state, dm, "/uploads/next.png");
    drain(&mut rx);
    (state, rx)
}

/// Drops a token onto a cell of one board or the other.
fn drop_at(id: &TokenId, x: f32, y: f32, staged: bool) -> ClientMsg {
    ClientMsg::MoveToken {
        id: id.clone(),
        x,
        y,
        dragging: false,
        staged,
    }
}

// --- the map ------------------------------------------------------------

#[test]
fn only_the_dm_may_change_the_map() {
    let mut state = room();
    let _player = join_as_player(&mut state, ClientId(1), "saelyn");
    let _dm = join_as_dm(&mut state, ClientId(2));

    assert!(
        state
            .check(ClientId(1), &set_map("/uploads/a.png", 70.0, 3.0, 4.0))
            .is_err()
    );
    assert!(
        state
            .check(ClientId(2), &set_map("/uploads/a.png", 70.0, 3.0, 4.0))
            .is_ok()
    );
}

#[test]
fn recalibrating_the_grid_does_not_move_a_single_token() {
    // Invariant 1, stated as a test. Positions are grid units, so a token
    // stays in the cell it was in however the grid is redefined underneath
    // it — this is the entire reason pixels are not stored.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let before: Vec<(TokenId, f32, f32)> = state
        .tokens
        .values()
        .map(|t| (t.id.clone(), t.x, t.y))
        .collect();

    state.handle(ClientId(1), set_map("/assets/map.png", 97.5, 13.0, -21.0));

    for (id, x, y) in before {
        let token = state.tokens.get(&id).expect("token survived");
        assert_eq!((token.x, token.y), (x, y), "{} moved", token.name);
    }
}

#[test]
fn a_new_map_replaces_every_field() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 12.5, 6.25));

    let map = &state.map;
    assert_eq!(map.url, "/uploads/cave.webp");
    assert_eq!(
        (map.grid_px, map.offset_x, map.offset_y),
        (70.0, 12.5, 6.25)
    );
}

// --- remembered calibration ----------------------------------------------

#[test]
fn re_picking_a_map_comes_back_calibrated() {
    // The whole point of the table: the DM calibrated this map weeks ago and
    // should not have to do it again.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
    );
    state.handle(
        ClientId(1),
        calibrate("/uploads/keep.png", 51.0, 2.0, "#aabbccdd"),
    );
    // Back to the first, with whatever defaults the client happened to send.
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 64.0, 0.0, "#ffffff52"),
    );

    let map = &state.map;
    assert_eq!(map.url, "/uploads/cave.png");
    assert_eq!(map.grid_px, 82.0, "the remembered grid should have won");
    assert_eq!((map.offset_x, map.offset_y), (7.0, -7.0));
    assert_eq!(map.grid_color, "#11223344");
    assert_eq!(map.play_area, rect(7.0, 7.0, 820.0, 656.0));
}

#[test]
fn the_current_map_can_still_be_recalibrated() {
    // The failure this guards against is total: if a remembered calibration
    // also won here, a map could never be corrected once it had been set.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
    );
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 96.0, 3.0, "#99887766"),
    );

    let map = &state.map;
    assert_eq!(map.grid_px, 96.0, "the DM's correction should have stuck");
    assert_eq!((map.offset_x, map.offset_y), (3.0, -3.0));
    assert_eq!(map.grid_color, "#99887766");
}

#[test]
fn a_recalibration_is_what_gets_remembered() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
    );
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 96.0, 3.0, "#99887766"),
    );
    state.handle(
        ClientId(1),
        calibrate("/uploads/keep.png", 51.0, 2.0, "#aabbccdd"),
    );
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 64.0, 0.0, "#ffffff52"),
    );

    assert_eq!(
        state.map.grid_px, 96.0,
        "the corrected calibration should have replaced the first one"
    );
}

#[test]
fn a_map_nobody_has_calibrated_keeps_what_the_client_sent() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        calibrate("/uploads/new.png", 77.0, 5.0, "#12345678"),
    );

    assert_eq!(state.map.grid_px, 77.0);
    assert_eq!(
        state
            .calibrations
            .get("/uploads/new.png")
            .map(|c| c.grid_px),
        Some(77.0),
        "a first sighting is worth remembering too"
    );
}

#[test]
fn a_remembered_calibration_never_reaches_a_client() {
    // It is server-side only. Everything a client needs is already in the
    // `MapInfo` the room sends back.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
    );

    let view = state.snapshot_for(&Identity::Dm);
    let json = serde_json::to_string(&view).expect("serialises");
    assert!(
        !json.contains("calibration"),
        "the table has no business on the wire: {json}"
    );
}

#[test]
fn the_calibration_table_is_saved() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
    );

    let saved = state.to_saved();
    assert_eq!(
        saved
            .calibrations
            .get("/uploads/cave.png")
            .map(|c| c.grid_px),
        Some(82.0)
    );

    // And survives the trip back, which is when it actually matters — the
    // group is not playing between sessions.
    let restored = RoomState::restored(saved, SECRET.to_owned());
    assert_eq!(
        restored
            .calibrations
            .get("/uploads/cave.png")
            .map(|c| c.grid_px),
        Some(82.0)
    );
}

#[test]
fn a_refused_calibration_is_not_remembered() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    // Rejected by `check`, so `apply` never runs and nothing is recorded.
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 0.5, 7.0, "#11223344"),
    );

    assert!(state.calibrations.is_empty());
    assert_ne!(state.map.url, "/uploads/cave.png");
}

// --- the staged map -------------------------------------------------------

#[test]
fn a_staged_map_is_not_in_a_players_snapshot() {
    // Invariant 4. Not sent-and-not-drawn — absent, so there is nothing in
    // devtools to find.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage(&mut state, ClientId(1), "/uploads/next.png");

    let view = state.snapshot_for(&Identity::Player(PlayerId::new("saelyn")));
    assert!(view.staged.is_none());

    let json = serde_json::to_string(&view).expect("serialises");
    assert!(
        !json.contains("next.png"),
        "the next dungeon leaked into a player's snapshot: {json}"
    );
}

#[test]
fn the_dm_sees_the_staged_map_in_their_snapshot() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage(&mut state, ClientId(1), "/uploads/next.png");

    let view = state.snapshot_for(&Identity::Dm);
    assert_eq!(view.staged.map(|m| m.url), Some("/uploads/next.png".into()));
}

#[test]
fn a_staged_map_never_reaches_a_player_as_a_delta() {
    // The other half of invariant 3: filtering the join snapshot is worth
    // nothing if the deltas leak it afterwards.
    let mut state = room();
    let dm = ClientId(1);
    let player = ClientId(2);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut player_rx = join_as_player(&mut state, player, "saelyn");

    stage(&mut state, dm, "/uploads/next.png");

    assert!(
        matches!(dm_rx.try_recv(), Ok(ServerMsg::StagedChanged { map: Some(m) }) if m.url == "/uploads/next.png")
    );
    assert!(
        player_rx.try_recv().is_err(),
        "a player should have been sent nothing at all"
    );
}

#[test]
fn staging_a_map_leaves_the_board_alone() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let before = state.map.url.clone();

    stage(&mut state, ClientId(1), "/uploads/next.png");

    assert_eq!(state.map.url, before, "the table is still on the old map");
    assert_eq!(
        state.staged.as_ref().map(|m| m.grid_px),
        Some(80.0),
        "and the staged slot holds what was sent"
    );
}

#[test]
fn a_player_cannot_stage_promote_or_discard() {
    let mut state = room();
    let _player = join_as_player(&mut state, ClientId(1), "saelyn");
    let _dm = join_as_dm(&mut state, ClientId(2));
    stage(&mut state, ClientId(2), "/uploads/next.png");

    for msg in [
        staged(set_map("/uploads/theirs.png", 64.0, 0.0, 0.0)),
        ClientMsg::PromoteStaged,
        ClientMsg::ClearStaged,
    ] {
        assert!(
            state.check(ClientId(1), &msg).is_err(),
            "{msg:?} should be DM-only"
        );
        assert!(state.check(ClientId(2), &msg).is_ok());
    }
}

#[test]
fn promoting_puts_the_staged_map_on_the_board_and_empties_the_slot() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage(&mut state, ClientId(1), "/uploads/next.png");

    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    assert_eq!(state.map.url, "/uploads/next.png");
    assert_eq!(state.map.grid_px, 80.0, "calibrated while staged");
    assert!(state.staged.is_none(), "one slot, and it has been spent");
}

#[test]
fn promoting_reaches_the_table_but_the_empty_slot_reaches_only_the_dm() {
    let mut state = room();
    let dm = ClientId(1);
    let player = ClientId(2);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut player_rx = join_as_player(&mut state, player, "saelyn");
    stage(&mut state, dm, "/uploads/next.png");
    let _staged_echo = dm_rx.try_recv().expect("the staging echo");

    state.handle(dm, ClientMsg::PromoteStaged);

    assert!(
        matches!(player_rx.try_recv(), Ok(ServerMsg::MapChanged { map }) if map.url == "/uploads/next.png")
    );
    assert!(
        player_rx.try_recv().is_err(),
        "the slot emptying is not a player's business"
    );

    assert!(matches!(dm_rx.try_recv(), Ok(ServerMsg::MapChanged { .. })));
    assert!(matches!(
        dm_rx.try_recv(),
        Ok(ServerMsg::StagedChanged { map: None })
    ));
}

#[test]
fn promoting_does_not_move_a_single_token() {
    // Tokens are stored in cells, so there is nothing sensible to carry them
    // across two unrelated images by. They stay put and the DM repositions.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let before: Vec<(TokenId, f32, f32)> = state
        .tokens
        .values()
        .map(|t| (t.id.clone(), t.x, t.y))
        .collect();

    stage(&mut state, ClientId(1), "/uploads/next.png");
    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    for (id, x, y) in before {
        let token = state.tokens.get(&id).expect("token survived");
        assert_eq!((token.x, token.y), (x, y), "{} moved", token.name);
    }
}

#[test]
fn discarding_empties_the_slot_and_leaves_the_board_alone() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let before = state.map.url.clone();
    stage(&mut state, ClientId(1), "/uploads/next.png");

    state.handle(ClientId(1), ClientMsg::ClearStaged);

    assert!(state.staged.is_none());
    assert_eq!(state.map.url, before);
}

#[test]
fn promoting_or_discarding_nothing_is_refused() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for msg in [ClientMsg::PromoteStaged, ClientMsg::ClearStaged] {
        let refusal = state.check(ClientId(1), &msg).expect_err("nothing staged");
        assert!(refusal.contains("no map staged"), "{refusal}");
    }
}

#[test]
fn a_calibration_made_while_staged_is_remembered() {
    // Which is what makes the promoted map arrive already calibrated, and
    // what makes re-picking it weeks later come back the same.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        staged(calibrate("/uploads/next.png", 91.0, 4.0, "#aabbccdd")),
    );

    assert_eq!(
        state
            .calibrations
            .get("/uploads/next.png")
            .map(|c| c.grid_px),
        Some(91.0)
    );

    state.handle(ClientId(1), ClientMsg::PromoteStaged);
    assert_eq!(state.map.grid_px, 91.0);
    assert_eq!(state.map.grid_color, "#aabbccdd");
}

#[test]
fn staging_a_map_calibrated_earlier_comes_back_calibrated() {
    // The staged slot is empty, so this is a load — and a load loses to
    // whatever the room already remembers for that URL.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 82.0, 7.0, "#11223344"),
    );

    state.handle(
        ClientId(1),
        staged(calibrate("/uploads/cave.png", 64.0, 0.0, "#ffffff52")),
    );

    assert_eq!(
        state.staged.as_ref().map(|m| m.grid_px),
        Some(82.0),
        "the client's opening bid should have lost to the remembered value"
    );
}

#[test]
fn the_staged_map_can_still_be_recalibrated() {
    // The other half of the URL rule, in the staged slot: a URL the slot is
    // already showing is a correction, and it must win.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        staged(calibrate("/uploads/next.png", 64.0, 0.0, "#ffffff52")),
    );

    state.handle(
        ClientId(1),
        staged(calibrate("/uploads/next.png", 96.0, 3.0, "#aabbccdd")),
    );

    assert_eq!(state.staged.as_ref().map(|m| m.grid_px), Some(96.0));
    assert_eq!(
        state
            .calibrations
            .get("/uploads/next.png")
            .map(|c| c.grid_px),
        Some(96.0),
        "and the correction is what gets remembered"
    );
}

#[test]
fn a_staged_map_is_worth_saving_and_survives_the_trip() {
    // Slate is off between sessions, so a map staged on Sunday for next week
    // is only useful if the file holds it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(
        state.handle(
            ClientId(1),
            staged(set_map("/uploads/next.png", 80.0, 0.0, 0.0))
        ),
        "staging should mark the room dirty"
    );

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = RoomState::restored(saved, SECRET.to_owned());

    assert_eq!(
        restored.staged.as_ref().map(|m| m.url.as_str()),
        Some("/uploads/next.png")
    );
    assert_eq!(restored.staged.as_ref().map(|m| m.grid_px), Some(80.0));
}

#[test]
fn only_the_dm_is_told_the_staged_slot_changed() {
    let mut state = room();
    let dm = ClientId(1);
    let player = ClientId(2);
    let _dm_rx = join_as_dm(&mut state, dm);
    let _player_rx = join_as_player(&mut state, player, "saelyn");

    assert!(state.message_for(dm, dm, &Event::StagedChanged).is_some());
    assert!(
        state
            .message_for(player, dm, &Event::StagedChanged)
            .is_none()
    );
    assert!(
        state
            .message_for(ClientId(3), dm, &Event::StagedChanged)
            .is_none(),
        "a connection with no identity is told nothing either"
    );
}

// --- preparing the next room ----------------------------------------------

#[test]
fn planning_a_move_leaves_the_token_where_it_stands() {
    // The whole state model in one assertion: one token, two positions, and
    // only the plan is what a preview drag writes.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let before = token(&state, "t1");

    state.handle(ClientId(1), drop_at(&before.id, 11.4, 7.6, true));

    let after = token(&state, "t1");
    assert_eq!((after.x, after.y), (before.x, before.y));
    assert_eq!(after.staged_pos, Some(Pos { x: 11.5, y: 7.5 }));
    assert!(!after.staged_only, "it is still on the board");
}

#[test]
fn a_plan_settles_on_the_lattice_its_size_belongs_to() {
    // `snap_to_cell` is the server's alone and does not care which of a
    // token's two positions it is settling — a 2×2 lands on a cell corner
    // either way.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    state.handle(ClientId(1), create("Ogre Chief", 2.0, Owner::Dm));
    let id = made(&state, "Ogre Chief").id;

    state.handle(ClientId(1), drop_at(&id, 4.4, 9.6, true));
    assert_eq!(
        made(&state, "Ogre Chief").staged_pos,
        Some(Pos { x: 4.0, y: 10.0 })
    );
}

#[test]
fn a_dragged_plan_is_relayed_unsnapped_and_the_drop_settles_it() {
    // The two message rates, on the plan. A second DM tab watches the drag
    // exactly as it watches one on the board.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let mut other_tab = join_as_dm(&mut state, ClientId(2));
    let id = token(&state, "t1").id;

    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: id.clone(),
            x: 3.3,
            y: 4.7,
            dragging: true,
            staged: true,
        },
    );
    assert_eq!(
        token(&state, "t1").staged_pos,
        Some(Pos { x: 3.3, y: 4.7 }),
        "a drag frame is left exactly where the pointer was"
    );
    assert!(matches!(
        other_tab.try_recv(),
        Ok(ServerMsg::TokenMoved {
            staged: true,
            dragging: true,
            ..
        })
    ));

    state.handle(ClientId(1), drop_at(&id, 3.3, 4.7, true));
    assert_eq!(token(&state, "t1").staged_pos, Some(Pos { x: 3.5, y: 4.5 }));
}

#[test]
fn a_plan_is_a_frame_the_table_never_receives() {
    // The `StagedChanged` arm, at token scale. A plan is a cell on a map the
    // players have not been shown, so the frame carrying it does not exist
    // for them — it is not sent and left undrawn.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let id = token(&state, "t2").id; // Saelyn's own token

    state.handle(ClientId(1), drop_at(&id, 15.0, 15.0, true));

    assert!(
        drain(&mut saelyn).is_empty(),
        "a plan for a player's own token is still not theirs to know"
    );
}

#[test]
fn a_plan_needs_a_map_to_be_a_plan_about() {
    // Refused the way promoting nothing is refused. Allowing it would mint
    // staged state belonging to a staged map that does not exist.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let id = token(&state, "t1").id;

    assert!(
        state
            .check(ClientId(1), &drop_at(&id, 2.0, 2.0, true))
            .is_err()
    );
    assert!(state.check(ClientId(1), &create_staged("Goblin")).is_err());
    // And the same commands are fine the moment there is one.
    stage(&mut state, ClientId(1), "/uploads/next.png");
    assert!(
        state
            .check(ClientId(1), &drop_at(&id, 2.0, 2.0, true))
            .is_ok()
    );
    assert!(state.check(ClientId(1), &create_staged("Goblin")).is_ok());
}

#[test]
fn only_the_dm_may_plan_a_move() {
    // A player may move their own token; the plan for it is not theirs.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let id = token(&state, "t2").id;

    assert!(
        state
            .check(ClientId(2), &drop_at(&id, 2.0, 2.0, false))
            .is_ok()
    );
    assert!(
        state
            .check(ClientId(2), &drop_at(&id, 2.0, 2.0, true))
            .is_err()
    );
}

#[test]
fn a_staged_only_token_is_nowhere_the_table_can_reach() {
    // The `hidden` filter, arrived at by the other of its two routes. This
    // creature was never on the board rather than taken off it, and every
    // door out of the room has to be shut just the same.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), create_staged("Ambusher"));
    let id = made(&state, "Ambusher").id;

    let view = state.snapshot_for(&as_player("saelyn"));
    assert!(!names(&view).contains(&"Ambusher"));
    let json = serde_json::to_string(&view).expect("serialises");
    assert!(!json.contains("Ambusher"), "leaked into a snapshot: {json}");

    // Nor as a delta: neither the creation nor a plan dragged around after.
    state.handle(ClientId(1), drop_at(&id, 9.0, 9.0, true));
    state.handle(ClientId(1), drop_at(&id, 9.0, 9.0, false));
    assert!(
        drain(&mut saelyn).is_empty(),
        "the table heard about it anyway"
    );
}

#[test]
fn the_dms_own_live_board_does_not_hold_a_staged_only_token_either() {
    // Not a detail: switching back to `Map` mode has to show the board as
    // the table sees it, and the DM's snapshot is where that starts. The
    // token is present — it is theirs to drag — and flagged as not real yet.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    state.handle(ClientId(1), create_staged("Ambusher"));

    let ambusher = made(&state, "Ambusher");
    assert!(ambusher.staged_only);
    assert_eq!(
        ambusher.staged_pos,
        Some(Pos {
            x: ambusher.x,
            y: ambusher.y
        }),
        "built somewhere, and that somewhere is its plan"
    );

    let view = state.snapshot_for(&Identity::Dm);
    let sent = view
        .tokens
        .iter()
        .find(|t| t.name == "Ambusher")
        .expect("the DM holds it");
    assert!(sent.staged_only, "and knows not to draw it on the board");
}

#[test]
fn a_staged_only_token_has_no_position_on_the_board_to_move() {
    // The complement of "a plan needs a staged map". The client never offers
    // this, because the token is absent from the live board; refusing says
    // so rather than writing a field the next promote overwrites.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    state.handle(ClientId(1), create_staged("Ambusher"));
    let id = made(&state, "Ambusher").id;

    let err = state
        .check(ClientId(1), &drop_at(&id, 1.0, 1.0, false))
        .expect_err("should be refused");
    assert!(err.contains("Ambusher"), "should name the token: {err}");
    assert!(
        state
            .check(ClientId(1), &drop_at(&id, 1.0, 1.0, true))
            .is_ok()
    );
}

#[test]
fn a_staged_only_token_cannot_be_rolled_into_combat() {
    // Combat is the fight happening now, and building next room's order in
    // advance needs rolls nobody has made.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    state.handle(ClientId(1), create_staged("Ambusher"));
    let id = made(&state, "Ambusher").id;

    let err = state
        .check(
            ClientId(1),
            &ClientMsg::SetInitiative {
                token: id,
                value: 17,
            },
        )
        .expect_err("should be refused");
    assert!(err.contains("Ambusher"), "should name the token: {err}");
    assert!(state.initiative.entries.is_empty());
}

#[test]
fn an_edit_reaches_both_boards_at_once() {
    // Only position and existence fork. A resize applies to the token, and
    // therefore to its plan as well — missed, a token resized after being
    // planned straddles half a cell the moment it is promoted.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    state.handle(ClientId(1), create("Dire Wolf", 1.0, Owner::Dm));
    let wolf = made(&state, "Dire Wolf");
    state.handle(ClientId(1), drop_at(&wolf.id, 6.5, 4.5, true));

    let grown = match edit(&made(&state, "Dire Wolf")) {
        ClientMsg::UpdateToken {
            id,
            name,
            img,
            owner,
            hidden,
            hp,
            ..
        } => ClientMsg::UpdateToken {
            id,
            name,
            img,
            size: 2.0,
            owner,
            hidden,
            hp,
        },
        other => other,
    };
    state.handle(ClientId(1), grown);

    let after = made(&state, "Dire Wolf");
    assert_eq!(after.size, 2.0);
    assert_eq!(
        after.staged_pos,
        Some(Pos { x: 7.0, y: 5.0 }),
        "the plan moved onto the even lattice with the token"
    );
}

#[test]
fn promoting_applies_every_plan_and_empties_the_fields() {
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let planned = token(&state, "t1").id;
    state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
    state.handle(ClientId(1), create_staged("Ambusher"));
    let unplanned_before = token(&state, "t6");

    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    let cleodara = token(&state, "t1");
    assert_eq!((cleodara.x, cleodara.y), (20.5, 1.5), "the plan came true");
    assert_eq!(cleodara.staged_pos, None, "and stopped being a plan");

    let ambusher = made(&state, "Ambusher");
    assert!(!ambusher.staged_only, "it exists on the board now");
    assert_eq!(ambusher.staged_pos, None);

    let after = token(&state, "t6");
    assert_eq!(
        (after.x, after.y),
        (unplanned_before.x, unplanned_before.y),
        "a token with no plan is still the DM's to reposition"
    );
}

#[test]
fn a_promote_says_three_different_things_to_three_recipients() {
    let (mut state, mut dm_rx) = staged_room(ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    let moving = token(&state, "t1").id; // seen all along, and planned
    state.handle(ClientId(1), drop_at(&moving, 20.5, 1.5, true));
    state.handle(ClientId(1), create_staged("Ambusher")); // never seen
    let ambusher = made(&state, "Ambusher").id;
    drain(&mut dm_rx);
    drain(&mut saelyn);

    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    // The DM gets whole tokens, because their client holds the two fields
    // that were just emptied and no `TokenMoved` could tell them so.
    let to_dm = drain(&mut dm_rx);
    for id in [&moving, &ambusher] {
        assert!(
            to_dm.iter().any(|msg| matches!(
                msg,
                ServerMsg::TokenChanged { token }
                    if &token.id == id && token.staged_pos.is_none() && !token.staged_only
            )),
            "the DM was not told {id:?} had its plan applied: {to_dm:?}"
        );
    }

    let to_saelyn = drain(&mut saelyn);
    // A creation for the one they are meeting for the first time…
    assert!(
        to_saelyn.iter().any(|msg| matches!(
            msg,
            ServerMsg::TokenChanged { token } if token.id == ambusher
        )),
        "the ambusher should arrive as a creation: {to_saelyn:?}"
    );
    // …and a plain move for the one they have been watching all along.
    assert!(
        to_saelyn.iter().any(|msg| matches!(
            msg,
            ServerMsg::TokenMoved { id, x, y, .. } if id == &moving && (*x, *y) == (20.5, 1.5)
        )),
        "the planned token should arrive as a move: {to_saelyn:?}"
    );
    assert!(
        !to_saelyn
            .iter()
            .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.id == moving)),
        "and not also as an edit: {to_saelyn:?}"
    );
}

#[test]
fn a_promote_leaves_a_still_hidden_creature_unannounced() {
    // A promote settles `staged_only`. It says nothing about a monster the
    // DM also took off the board, and the table must not meet it early.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(
        ClientId(1),
        with(create_staged("Ambusher"), |hidden, _| *hidden = true),
    );
    drain(&mut saelyn);

    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    let to_saelyn = drain(&mut saelyn);
    assert!(
        to_saelyn
            .iter()
            .all(|msg| matches!(msg, ServerMsg::MapChanged { .. })),
        "only the map should have reached the table: {to_saelyn:?}"
    );
    assert!(made(&state, "Ambusher").hidden, "and it is still hidden");
}

#[test]
fn discarding_the_staged_map_takes_the_plans_made_on_it_with_it() {
    // Otherwise the next map inherits monsters placed on a map nobody will
    // ever see again — and staged-only tokens no board draws at all.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let planned = token(&state, "t1").id;
    state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
    state.handle(ClientId(1), create_staged("Ambusher"));
    let before = state.tokens.len();

    state.handle(ClientId(1), ClientMsg::ClearStaged);

    assert_eq!(token(&state, "t1").staged_pos, None);
    assert_eq!(state.tokens.len(), before - 1, "the ambusher is gone");
    assert!(state.tokens.values().all(|t| !t.staged_only));
    assert_eq!(
        (token(&state, "t1").x, token(&state, "t1").y),
        (3.5, 3.5),
        "and the board itself was never touched"
    );
}

#[test]
fn discarding_a_plan_is_not_something_the_table_is_told_about() {
    // A player's copy of a planned token is identical either side of this,
    // so the only thing a frame could carry them is the news that the DM
    // just threw a plan away — which is news, and invariant 4's concern.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let planned = token(&state, "t1").id;
    state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
    state.handle(ClientId(1), create_staged("Ambusher"));
    drain(&mut saelyn);

    state.handle(ClientId(1), ClientMsg::ClearStaged);

    assert!(
        drain(&mut saelyn).is_empty(),
        "nothing about this was the table's to hear"
    );
}

#[test]
fn the_dm_is_told_when_a_plan_is_cleared_out_from_under_them() {
    let (mut state, mut dm_rx) = staged_room(ClientId(1));
    let planned = token(&state, "t1").id;
    state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
    state.handle(ClientId(1), create_staged("Ambusher"));
    let ambusher = made(&state, "Ambusher").id;
    drain(&mut dm_rx);

    state.handle(ClientId(1), ClientMsg::ClearStaged);

    let msgs = drain(&mut dm_rx);
    assert!(
        msgs.iter().any(|msg| matches!(
            msg,
            ServerMsg::TokenChanged { token }
                if token.id == planned && token.staged_pos.is_none()
        )),
        "the cleared plan should reach the DM's other tabs: {msgs:?}"
    );
    assert!(
        msgs.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id == &ambusher)),
        "and so should the deleted token: {msgs:?}"
    );
}

#[test]
fn staging_a_different_map_clears_the_plans_but_recalibrating_does_not() {
    // The arm that gets missed. `SetMap` already tells a load from a
    // recalibration by URL; correcting the grid after placing an ambush is
    // an ordinary thing to do and must not sweep the ambush away.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let planned = token(&state, "t1").id;
    state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));
    state.handle(ClientId(1), create_staged("Ambusher"));

    state.handle(
        ClientId(1),
        staged(calibrate("/uploads/next.png", 96.0, 4.0, "#aabbccdd")),
    );
    assert_eq!(
        token(&state, "t1").staged_pos,
        Some(Pos { x: 20.5, y: 1.5 }),
        "a recalibration is not a new next room"
    );
    assert!(made(&state, "Ambusher").staged_only);

    stage(&mut state, ClientId(1), "/uploads/somewhere-else.png");
    assert_eq!(token(&state, "t1").staged_pos, None);
    assert!(
        state.tokens.values().all(|t| t.name != "Ambusher"),
        "a monster placed for a room nobody will visit should not follow"
    );
}

#[test]
fn loading_a_new_board_leaves_the_plans_for_the_next_one_alone() {
    // A plan describes a cell on the staged map, which this has not touched.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let planned = token(&state, "t1").id;
    state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true));

    state.handle(
        ClientId(1),
        set_map("/uploads/somewhere.png", 64.0, 0.0, 0.0),
    );

    assert_eq!(
        token(&state, "t1").staged_pos,
        Some(Pos { x: 20.5, y: 1.5 })
    );
}

#[test]
fn deleting_a_token_takes_its_plan_with_it() {
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    state.handle(ClientId(1), create("Dire Wolf", 1.0, Owner::Dm));
    let id = made(&state, "Dire Wolf").id;
    state.handle(ClientId(1), drop_at(&id, 12.5, 12.5, true));

    state.handle(ClientId(1), ClientMsg::DeleteToken { id: id.clone() });

    assert!(!state.tokens.contains_key(&id));
}

#[test]
fn a_plan_is_worth_saving_and_survives_the_trip() {
    // Slate is off between sessions, and the whole point of preparing the
    // next room is that it is prepared on a different evening.
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let planned = token(&state, "t1").id;
    assert!(
        state.handle(ClientId(1), drop_at(&planned, 20.5, 1.5, true)),
        "planning should mark the room dirty"
    );
    state.handle(ClientId(1), create_staged("Ambusher"));

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = RoomState::restored(saved, SECRET.to_owned());

    assert_eq!(
        token(&restored, "t1").staged_pos,
        Some(Pos { x: 20.5, y: 1.5 })
    );
    assert!(made(&restored, "Ambusher").staged_only);
}

#[test]
fn a_dragged_plan_is_not_worth_saving_but_the_drop_is() {
    let (mut state, _dm_rx) = staged_room(ClientId(1));
    let id = token(&state, "t1").id;

    assert!(
        !state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: id.clone(),
                x: 5.0,
                y: 5.0,
                dragging: true,
                staged: true,
            }
        ),
        "a plan is dragged into place like a token, and costs the disk as little"
    );
    assert!(state.handle(ClientId(1), drop_at(&id, 5.0, 5.0, true)));
}

#[test]
fn an_unusable_grid_size_is_refused() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for px in [0.0, -70.0, 0.5, 1e9] {
        assert!(
            state
                .check(ClientId(1), &set_map("/assets/map.png", px, 0.0, 0.0))
                .is_err(),
            "{px} should be refused"
        );
    }
    assert!(
        state
            .check(ClientId(1), &set_map("/assets/map.png", 4.0, 0.0, 0.0))
            .is_ok()
    );
    assert!(
        state
            .check(ClientId(1), &set_map("/assets/map.png", 4096.0, 0.0, 0.0))
            .is_ok()
    );
}

#[test]
fn an_empty_or_absurd_map_url_is_refused() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    assert!(
        state
            .check(ClientId(1), &set_map("", 64.0, 0.0, 0.0))
            .is_err()
    );
    let long = "/uploads/".to_owned() + &"a".repeat(MAX_URL_LEN);
    assert!(
        state
            .check(ClientId(1), &set_map(&long, 64.0, 0.0, 0.0))
            .is_err()
    );
}

#[test]
fn only_a_hex_rgba_colour_is_accepted() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for good in ["#ffffff52", "#000000ff", "#FFAA0080", "#00000000"] {
        assert!(
            state.check(ClientId(1), &set_color(good)).is_ok(),
            "{good} should be fine"
        );
    }

    for bad in [
        "#ffffff", // no alpha; the part that matters most would be missing
        "#fff",
        "ffffff52", // no hash
        "#gggggggg",
        "#ffffff521",
        "",
        "rgba(255, 255, 255, 0.3)",
        "white",
        "#ffffff5\u{00e9}", // nine bytes, but not nine hex digits
    ] {
        assert!(
            state.check(ClientId(1), &set_color(bad)).is_err(),
            "{bad:?} should be refused"
        );
    }
}

#[test]
fn the_default_grid_colour_is_one_the_server_would_accept() {
    // The default ships in `MapInfo::default` and is what every old save
    // gets filled in with, so it has to pass the same check as any other.
    assert!(is_hex_rgba(&MapInfo::default().grid_color));
}

#[test]
fn the_grid_colour_survives_a_change() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), set_color("#33ff9980"));
    assert_eq!(state.map.grid_color, "#33ff9980");
}

#[test]
fn a_play_area_defaults_to_the_whole_image() {
    // The server never sees the image, so `None` is the only thing it could
    // mean by "all of it" — and it is what every older save says.
    assert_eq!(room().map.play_area, None);
}

#[test]
fn a_play_area_survives_a_change() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), set_area(rect(128.0, 64.0, 640.0, 448.0)));
    assert_eq!(state.map.play_area, rect(128.0, 64.0, 640.0, 448.0));
}

#[test]
fn a_play_area_can_be_cleared_back_to_the_whole_image() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), set_area(rect(128.0, 64.0, 640.0, 448.0)));
    state.handle(ClientId(1), set_area(None));
    assert_eq!(state.map.play_area, None);
}

#[test]
fn an_unusable_play_area_is_refused() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    let bad = [
        rect(0.0, 0.0, 0.0, 100.0),    // no width
        rect(0.0, 0.0, 100.0, 0.0),    // no height
        rect(0.0, 0.0, -640.0, 448.0), // inside out
        rect(0.0, 0.0, 1.0e9, 448.0),  // more grid lines than frames
        rect(0.0, 0.0, 640.0, 1.0e9),
        rect(f32::NAN, 0.0, 640.0, 448.0),
        rect(0.0, 0.0, 10.0, 448.0), // narrower than one 64 px cell
    ];
    for area in bad {
        assert!(
            state.check(ClientId(1), &set_area(area)).is_err(),
            "{area:?} should be refused"
        );
    }

    assert!(
        state
            .check(ClientId(1), &set_area(rect(0.0, 0.0, 64.0, 64.0)))
            .is_ok()
    );
    assert!(
        state.check(ClientId(1), &set_area(None)).is_ok(),
        "the whole image is always fine"
    );
}

#[test]
fn a_negative_play_area_origin_is_allowed() {
    // The origin is not bounded the way the size is: a DM may legitimately
    // rule a board that starts off the top-left of the image, and the client
    // clips to the image before it draws anything.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(
        state
            .check(ClientId(1), &set_area(rect(-320.0, -64.0, 640.0, 448.0)))
            .is_ok()
    );
}

#[test]
fn a_map_change_reaches_the_dm_who_made_it() {
    // Unlike a drag frame there is no local prediction to rubber-band, so
    // the originator needs this echo to see the grid it asked for.
    let state = room();
    let me = ClientId(1);
    assert!(state.message_for(me, me, &Event::MapChanged).is_some());
    assert!(
        state
            .message_for(ClientId(2), me, &Event::MapChanged)
            .is_some()
    );
}

#[test]
fn a_map_change_is_worth_saving() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 1.0, 2.0)));
}

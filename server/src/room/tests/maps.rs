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
        lighting: Lighting::Dynamic,
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
        lighting: Lighting::Dynamic,
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
        lighting: Lighting::Dynamic,
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
fn how_a_map_is_lit_comes_back_with_its_grid() {
    // The dungeon reveals a room at a time and the meadow outside it keeps line
    // of sight, and the DM should not have to remember which is which when they
    // swap between them. Same table, same rule as the fog switch beside it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        room_lit(fogged(set_map("/uploads/cave.png", 64.0, 0.0, 0.0), 40.0)),
    );
    state.handle(ClientId(1), set_map("/uploads/meadow.png", 64.0, 0.0, 0.0));
    assert_eq!(state.map.lighting, Lighting::Dynamic, "the meadow's own");

    // Back to the cave, with whatever the client happened to send.
    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    assert_eq!(state.map.lighting, Lighting::Room);
    assert!(state.map.fog, "and the switch it was remembered beside");
    assert_eq!(state.map.vision_ft, 40.0);
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
            .map(|c| c.calibration.grid_px),
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
            .map(|c| c.calibration.grid_px),
        Some(82.0)
    );

    // And survives the trip back, which is when it actually matters — the
    // group is not playing between sessions.
    let restored = RoomState::restored(saved, SECRET.to_owned());
    assert_eq!(
        restored
            .calibrations
            .get("/uploads/cave.png")
            .map(|c| c.calibration.grid_px),
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

// --- the shelf ------------------------------------------------------------

/// The ids of what is traced on one board or the other.
fn traced(state: &RoomState, staged: bool) -> Vec<WallId> {
    state
        .walls_in(staged)
        .iter()
        .map(|w| w.id.clone())
        .collect()
}

/// What the room remembers having been traced on one image.
fn shelved(state: &RoomState, url: &str) -> Vec<WallId> {
    state
        .calibrations
        .get(url)
        .map(|p| p.walls.iter().map(|w| w.id.clone()).collect())
        .unwrap_or_default()
}

#[test]
fn a_map_traced_on_a_tuesday_is_still_traced_on_saturday() {
    // The whole milestone: the DM walls a dungeon, runs something else, and
    // finds the dungeon still walled when they come back to it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    let traced_in_the_cave = traced(&state, false);
    assert_eq!(traced_in_the_cave.len(), 1);

    state.handle(ClientId(1), set_map("/uploads/keep.png", 64.0, 0.0, 0.0));
    assert!(
        state.walls.is_empty(),
        "the keep is a different dungeon and none of the cave's masonry is in it"
    );

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    assert_eq!(traced(&state, false), traced_in_the_cave);
}

#[test]
fn the_paint_comes_back_with_the_tracing() {
    // The DM's overrides are authoring like the walls are, and they are filed
    // and restored beside them rather than by a second mechanism.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    // Fogged, because paint on a map with no fog on it is refused rather than
    // stored — the shelf can only remember what the room would hold.
    state.handle(
        ClientId(1),
        fogged(set_map("/uploads/cave.png", 64.0, 0.0, 0.0), 60.0),
    );
    state.handle(ClientId(1), paint(&[(3, 4)], Some(Override::Dark)));

    state.handle(ClientId(1), set_map("/uploads/keep.png", 64.0, 0.0, 0.0));
    assert!(state.overrides.is_empty());

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    assert_eq!(state.overrides.get(&(3, 4)), Some(&Override::Dark));
}

#[test]
fn walls_are_filed_under_the_map_they_were_traced_on() {
    // The trap that reads as a bug in the wall editor. `sweep_board` is called
    // *after* the assignment on this path, so a version that asked `self.map`
    // which board it was sweeping would file the cave's masonry under the
    // keep — and the DM would find it laid across the keep next week.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    state.handle(ClientId(1), set_map("/uploads/keep.png", 64.0, 0.0, 0.0));

    assert_eq!(shelved(&state, "/uploads/cave.png").len(), 1);
    assert!(
        shelved(&state, "/uploads/keep.png").is_empty(),
        "nothing has ever been traced on the keep"
    );
}

#[test]
fn nudging_the_grid_does_not_erase_what_the_room_remembers() {
    // The silent one. A recalibration writes the calibration and must not be
    // able to reach the tracing beside it — and because the board keeps its
    // walls through a recalibration, a version that filed empty ones here would
    // look perfectly correct until the DM loaded away and back.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 64.0, 0.0, "#11223344"),
    );
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    // The board is filed onto the shelf only as it leaves, so the entry is
    // empty until then — which is exactly what makes the clobber invisible.
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 96.0, 3.0, "#99887766"),
    );
    assert_eq!(state.walls.len(), 1, "a recalibration keeps the walls");

    state.handle(
        ClientId(1),
        calibrate("/uploads/keep.png", 51.0, 2.0, "#aabbccdd"),
    );
    state.handle(
        ClientId(1),
        calibrate("/uploads/cave.png", 64.0, 0.0, "#ffffff52"),
    );
    assert_eq!(state.walls.len(), 1, "and so does the round trip");
    assert_eq!(
        state.map.grid_px, 96.0,
        "the correction is still what was remembered"
    );
}

#[test]
fn clearing_the_walls_and_loading_away_means_they_are_cleared() {
    // The shelf holds what the board was actually holding, empty included.
    // Filing only non-empty lists would make "I traced that badly and started
    // again" unsayable — the bad trace would come back next week.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    state.handle(ClientId(1), clear_walls());
    state.handle(ClientId(1), set_map("/uploads/keep.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));

    assert!(state.walls.is_empty());
}

#[test]
fn a_promote_files_the_board_it_covered() {
    // The second call site, and the one whose assignment is on the other side
    // of the sweep. The board being covered is the live one, and its masonry
    // belongs to the image it was traced on rather than to the image arriving
    // on top of it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    let traced_in_the_cave = traced(&state, false);

    stage(&mut state, ClientId(1), "/uploads/keep.png");
    state.handle(ClientId(1), ClientMsg::PromoteStaged);
    assert_eq!(state.map.url, "/uploads/keep.png");
    assert!(state.walls.is_empty());

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    assert_eq!(traced(&state, false), traced_in_the_cave);
}

#[test]
fn a_staged_map_is_filed_and_comes_back_staged() {
    // The write site that gets missed: a staged board never passes through
    // `sweep_board`, it dies where the load arm takes the slot. Three dungeons
    // prepped on a Tuesday is what the milestone was asked for, and all three
    // are prepped in this slot rather than on the board.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    // Fogged, so that the paint below is a command the room accepts — a staged
    // map may be painted while the unfogged live board under it may not.
    state.handle(
        ClientId(1),
        staged(fogged(set_map("/uploads/cave.png", 64.0, 0.0, 0.0), 60.0)),
    );
    state.handle(
        ClientId(1),
        staged(trace(&[(0.0, 0.0), (128.0, 0.0)], false)),
    );
    state.handle(ClientId(1), staged(paint(&[(2, 2)], Some(Override::Lit))));
    let traced_in_the_cave = traced(&state, true);
    assert_eq!(traced_in_the_cave.len(), 1);

    stage(&mut state, ClientId(1), "/uploads/keep.png");
    assert!(state.walls_in(true).is_empty(), "the keep is untraced");

    stage(&mut state, ClientId(1), "/uploads/cave.png");
    assert_eq!(traced(&state, true), traced_in_the_cave);
    let board = state.staged.as_ref().expect("the staged board");
    assert_eq!(board.overrides.get(&(2, 2)), Some(&Override::Lit));
}

#[test]
fn discarding_the_staged_slot_keeps_what_was_traced_on_the_map() {
    // The slot's other exit. The shelf is keyed by image and not by slot, so
    // which of the two buttons the DM pressed cannot change what next week's
    // load finds — throwing the *prep* away is `ClearWalls`.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    stage(&mut state, ClientId(1), "/uploads/cave.png");
    state.handle(
        ClientId(1),
        staged(trace(&[(0.0, 0.0), (128.0, 0.0)], false)),
    );
    state.handle(ClientId(1), ClientMsg::ClearStaged);

    assert!(state.staged.is_none());
    assert_eq!(shelved(&state, "/uploads/cave.png").len(), 1);
}

#[test]
fn the_party_re_explores_a_dungeon_they_return_to() {
    // The boundary, and what keeps this from being a scene restore: the DM's
    // authoring is remembered and the party's play state is not. A `revealed`
    // that came back with the walls would immediately raise "why not the token
    // positions too", and that road ends at the feature `docs/maps.md` refuses.
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        fogged(set_map("/uploads/cave.png", 64.0, 0.0, 0.0), 30.0),
    );
    // Out along the row and back again, so that what the party has *explored*
    // is strictly more than what they can see from where they end up. Without
    // the round trip the two sets are the same and the assertion below would
    // hold whether or not the shelf remembered them.
    walk(&mut state, 9.5);
    walk(&mut state, 1.5);
    assert!(
        !state.revealed.is_subset(&state.visible),
        "the party has been somewhere they cannot see from here"
    );

    state.handle(
        ClientId(1),
        fogged(set_map("/uploads/keep.png", 64.0, 0.0, 0.0), 30.0),
    );
    state.handle(
        ClientId(1),
        fogged(set_map("/uploads/cave.png", 64.0, 0.0, 0.0), 30.0),
    );

    // Whatever the tokens can see from where they are standing, and nothing
    // more: `recompute_sight` runs on the way out, so what is left is sight
    // rather than memory. No cell out of reach came back with the walls.
    assert!(
        state.revealed.is_subset(&state.visible),
        "returning to a dungeon is not remembering having walked it"
    );
}

#[test]
fn the_walls_coming_back_is_the_dms_news_and_nobody_elses() {
    // A load now emits `WallsChanged` and `OverridesChanged` where it used to
    // emit only the sweep's. Both reach the DM or nobody, which is the rule
    // they have always had — a player is not told the DM traced something, and
    // is not told the room remembered it either.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut player = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(
        ClientId(1),
        fogged(set_map("/uploads/cave.png", 64.0, 0.0, 0.0), 60.0),
    );
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    state.handle(ClientId(1), paint(&[(3, 4)], Some(Override::Dark)));
    state.handle(ClientId(1), set_map("/uploads/keep.png", 64.0, 0.0, 0.0));
    drain(&mut dm);
    drain(&mut player);

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));

    let to_dm = drain(&mut dm);
    assert!(
        to_dm.iter().any(|m| matches!(
            m,
            ServerMsg::WallsChanged {
                walls,
                staged: false
            } if walls.len() == 1
        )),
        "the DM is holding the masonry that just came back: {to_dm:?}"
    );
    assert!(
        to_dm
            .iter()
            .any(|m| matches!(m, ServerMsg::OverridesChanged { .. })),
        "and the paint: {to_dm:?}"
    );

    let to_player = drain(&mut player);
    assert!(
        !to_player.iter().any(|m| matches!(
            m,
            ServerMsg::WallsChanged { .. } | ServerMsg::OverridesChanged { .. }
        )),
        "a player holds no walls and is told of none: {to_player:?}"
    );
    assert!(
        to_player
            .iter()
            .any(|m| matches!(m, ServerMsg::MapChanged { .. })),
        "the map itself is everybody's: {to_player:?}"
    );
}

#[test]
fn swapping_between_two_traced_maps_names_the_walls_once() {
    // Both gates would fire on this load — the sweep's, because the board it
    // left was traced, and the restore's, because the board arriving is. A
    // `WallsChanged` carries whatever the room holds when it is *dispatched*,
    // so the second would name the same list as the first and say nothing.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    state.handle(ClientId(1), set_map("/uploads/keep.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), trace(&[(64.0, 64.0), (64.0, 192.0)], false));
    drain(&mut dm);

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));

    let framed: Vec<ServerMsg> = drain(&mut dm)
        .into_iter()
        .filter(|m| matches!(m, ServerMsg::WallsChanged { .. }))
        .collect();
    assert_eq!(framed.len(), 1, "one frame, naming what is there now");
    let Some(ServerMsg::WallsChanged { walls, .. }) = framed.first() else {
        unreachable!("filtered above")
    };
    assert_eq!(walls.len(), 1);
    assert_eq!(
        walls.first().expect("the cave's segment").to,
        Px { x: 128.0, y: 0.0 },
        "the cave's masonry, not the keep's"
    );
}

#[test]
fn the_shelf_never_reaches_a_client() {
    // `a_remembered_calibration_never_reaches_a_client`'s twin, and worth
    // asserting again now that an entry carries a dungeon's masonry rather than
    // four numbers. There is no `RoomView` field and no message.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _player = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), set_map("/uploads/cave.png", 64.0, 0.0, 0.0));
    state.handle(ClientId(1), trace(&[(0.0, 0.0), (128.0, 0.0)], false));
    state.handle(ClientId(1), set_map("/uploads/keep.png", 64.0, 0.0, 0.0));

    let view = state.snapshot_for(&as_player("saelyn"));
    let json = serde_json::to_string(&view).expect("a serialisable view");
    assert!(
        !json.contains("cave"),
        "the cave is on the shelf and nowhere a player can read: {json}"
    );
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
    assert_eq!(
        view.staged.map(|b| b.map.url),
        Some("/uploads/next.png".into())
    );
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
    settle(&mut [&mut dm_rx, &mut player_rx]);

    stage(&mut state, dm, "/uploads/next.png");

    assert!(
        matches!(dm_rx.try_recv(), Ok(ServerMsg::StagedChanged { board: Some(b) }) if b.map.url == "/uploads/next.png")
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
        state.staged.as_ref().map(|b| b.map.grid_px),
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
    // Everything staging told the DM, so what follows reads their queue from
    // empty. Drained rather than taken one frame at a time: staging is a
    // command like any other and rides an undo label along with its echo.
    assert!(!drain(&mut dm_rx).is_empty(), "the staging echo");

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
        Ok(ServerMsg::StagedChanged { board: None })
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
            .map(|c| c.calibration.grid_px),
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
        state.staged.as_ref().map(|b| b.map.grid_px),
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

    assert_eq!(state.staged.as_ref().map(|b| b.map.grid_px), Some(96.0));
    assert_eq!(
        state
            .calibrations
            .get("/uploads/next.png")
            .map(|c| c.calibration.grid_px),
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
        restored.staged.as_ref().map(|b| b.map.url.as_str()),
        Some("/uploads/next.png")
    );
    assert_eq!(restored.staged.as_ref().map(|b| b.map.grid_px), Some(80.0));
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

// --- the backdrop -------------------------------------------------------
//
// A picture shown *instead of* the board. It is in this file because it is
// about what is on the screens, and it is not a map — which is the whole of
// what these tests are here to hold down. See *Backdrop* in `docs/maps.md`.

const CAMPFIRE: &str = "/uploads/backdrop-campfire-9f8e7d6c.jpg";

fn show(url: Option<&str>) -> ClientMsg {
    ClientMsg::SetBackdrop {
        url: url.map(str::to_owned),
    }
}

#[test]
fn only_the_dm_can_put_a_picture_in_front_of_the_table() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    state.handle(ClientId(1), show(Some(CAMPFIRE)));

    assert!(
        state.backdrop.is_none(),
        "a player put a picture in front of five other people's boards"
    );
    // And the refusal is the only thing they got back, rather than a frame
    // describing a room that did not change.
    assert!(matches!(
        drain(&mut saelyn).as_slice(),
        [ServerMsg::Error { .. }]
    ));
}

#[test]
fn the_backdrop_reaches_the_table_and_the_dm_alike() {
    // `NamesChanged`'s rule rather than `WallsChanged`'s: who may put a
    // picture up is a permission, and which picture it is is not a secret —
    // six people are looking at it.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), show(Some(CAMPFIRE)));

    // Echoed to the DM who sent it, like the switches beside it: nothing here
    // is predicted locally, so this frame is how their own panel settles.
    assert!(
        matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::BackdropChanged { url: Some(url) }] if url == CAMPFIRE
        ),
        "the DM was not told their own pick landed"
    );
    assert!(
        matches!(
            drain(&mut saelyn).as_slice(),
            [ServerMsg::BackdropChanged { url: Some(url) }] if url == CAMPFIRE
        ),
        "the table was not shown the picture"
    );
}

#[test]
fn the_backdrop_is_in_every_snapshot() {
    // Invariant 3 on a field with no filter: a join has to arrive at the same
    // answer the delta gave, or a page refreshed mid-campfire comes back
    // looking at the dungeon on its own.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), show(Some(CAMPFIRE)));

    assert_eq!(
        state.snapshot_for(&Identity::Dm).backdrop.as_deref(),
        Some(CAMPFIRE)
    );
    assert_eq!(
        state.snapshot_for(&as_player("saelyn")).backdrop.as_deref(),
        Some(CAMPFIRE)
    );
}

#[test]
fn covering_the_board_leaves_the_encounter_exactly_where_it_was() {
    // **The test the whole feature exists for**, and it is the exact contrast
    // with `undoing_a_map_load_gives_back_the_walls_the_shapes_and_the_fog_together`
    // in `undo.rs`: that one asserts a map load destroys four things at once,
    // and this one asserts that showing a picture destroys none of them. A
    // future refactor routing this through `SetMap` fails here.
    let mut state = fog_room(60.0);
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    state.handle(dm, trace(&[(0.0, 0.0), (64.0, 0.0), (64.0, 64.0)], false));
    state.handle(
        dm,
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Point(Pos { x: 2.0, y: 2.0 }),
            to: Pos { x: 3.0, y: 0.0 },
            color: "#ff8c42e6".to_owned(),
        },
    );
    state.handle(dm, paint(&[(9, 9), (9, 10)], Some(Override::Dark)));
    let _ = drain_all(&mut dm_rx);

    let before = (
        state.walls.len(),
        state.shapes.len(),
        state.overrides.len(),
        state.revealed.len(),
        state.map.url.clone(),
    );
    assert!(before.0 > 0 && before.1 > 0 && before.2 > 0 && before.3 > 0);

    state.handle(dm, show(Some(CAMPFIRE)));

    // Nothing travelled with it, either. A `MapChanged`, a `WallsChanged` or a
    // `FogChanged` here would be the room telling six clients that the board
    // moved when the only thing that moved is what is in front of it.
    assert!(
        matches!(
            drain(&mut dm_rx).as_slice(),
            [ServerMsg::BackdropChanged { .. }]
        ),
        "covering the board sent something about the board"
    );

    // And back to it, which is the half a DM actually has to trust.
    state.handle(dm, show(None));

    let after = (
        state.walls.len(),
        state.shapes.len(),
        state.overrides.len(),
        state.revealed.len(),
        state.map.url.clone(),
    );
    assert_eq!(
        before, after,
        "half an hour of tracing, the drawings, the paint and the party's memory \
         have to still be there when the picture comes down"
    );
}

#[test]
fn a_backdrop_url_is_bounded_like_a_map_url() {
    // The only bound there is to apply. The picker only ever sends a path the
    // pick route just handed back, so this is about a hostile frame.
    let mut state = room();
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);

    assert!(state.check(dm, &show(Some(&"x".repeat(513)))).is_err());
    assert!(state.check(dm, &show(Some(""))).is_err());
    // And `None` is not an empty URL — it is the board.
    assert!(state.check(dm, &show(None)).is_ok());
}

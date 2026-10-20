//! Line of sight and the DM mask laid over it. See `docs/fog.md`.

use super::*;

fn sees_the_ogre(state: &RoomState) -> bool {
    names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Ogre")
}

/// The cell the ogre stands in, in `fog_room`.
const OGRE_CELL: Cell = (5, 1);

// --- fog of war ---------------------------------------------------------

#[test]
fn an_unfogged_map_sends_no_fog_at_all_and_hides_nobody() {
    // `None` is both "this map is not fogged" and "there is nothing to
    // show", indistinguishable from the client side. `staged` works the same
    // way, and it's why turning fog off needs no second field.
    let state = room();
    assert_eq!(state.snapshot_for(&as_player("saelyn")).fog, None);
    assert_eq!(state.snapshot_for(&Identity::Dm).fog, None);
    assert!(
        names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Ogre"),
        "with the lights on the table sees everything"
    );
}

#[test]
fn a_monster_beyond_the_torchlight_is_absent_from_the_table() {
    // Four cells away, with two cells of vision.
    let state = fog_room(10.0);
    assert!(!sees_the_ogre(&state));
    assert!(
        names(&state.snapshot_for(&Identity::Dm)).contains(&"Ogre"),
        "the DM sees their own monsters whatever the party can see"
    );
}

#[test]
fn a_wall_between_them_blocks_sight_and_a_door_in_it_opens_again() {
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));

    assert!(sees_the_ogre(&state), "nothing in the way yet");

    state.handle(ClientId(1), between(false));
    assert!(!sees_the_ogre(&state), "masonry stops the ray");

    let door = state.walls.first().expect("the wall").id.clone();
    state.walls.clear();
    state.handle(ClientId(1), between(true));
    let door = state.walls.first().map_or(door, |w| w.id.clone());
    assert!(!sees_the_ogre(&state), "a door is traced shut");

    state.handle(ClientId(1), swing(door));
    assert!(sees_the_ogre(&state), "and an open one is a way through");
}

#[test]
fn walking_through_the_doorway_introduces_the_monster_to_the_table() {
    // Line of sight in one test. The player moves; the monster is what the
    // frame that follows is about, and it is a whole token because they have
    // never held it.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(false));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");

    assert!(!sees_the_ogre(&state));
    drain(&mut rx);

    // Past the wall. Walls block sight and never movement (decided, not
    // deferred), so this is an ordinary drop that happens to cross one.
    state.handle(
        ClientId(2),
        ClientMsg::MoveToken {
            id: TokenId::new("p"),
            x: 4.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );

    let frames = drain(&mut rx);
    let met = frames
        .iter()
        .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.name == "Ogre"));
    assert!(met, "expected to meet the ogre, got {frames:?}");
    assert!(
        frames
            .iter()
            .any(|msg| matches!(msg, ServerMsg::FogChanged { fog: Some(_), .. })),
        "and the fog that lifted, got {frames:?}"
    );
}

#[test]
fn walking_back_out_takes_the_monster_off_their_board() {
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(false));
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("p"),
            x: 4.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    assert!(sees_the_ogre(&state));
    drain(&mut rx);

    state.handle(
        ClientId(2),
        ClientMsg::MoveToken {
            id: TokenId::new("p"),
            x: 1.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );

    let frames = drain(&mut rx);
    assert!(
        frames
            .iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "m")),
        "the ogre has to leave their board, got {frames:?}"
    );
}

#[test]
fn a_drag_frame_does_not_move_the_fog() {
    // Recompute on the drop, not on a drag frame. The raycast is cheap enough
    // at 30 Hz, but shipping a packed bitset to six people that often isn't.
    let mut state = fog_room(60.0);
    let mut rx = join_as_dm(&mut state, ClientId(1));
    drain(&mut rx);

    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("p"),
            x: 9.5,
            y: 9.5,
            dragging: true,
            staged: false,
        },
    );

    let frames = drain(&mut rx);
    assert!(
        !frames
            .iter()
            .any(|msg| matches!(msg, ServerMsg::FogChanged { .. })),
        "a drag frame must not ship a bitset, got {frames:?}"
    );
}

#[test]
fn the_fog_frame_reaches_the_table_and_the_dm_alike() {
    // The opposite of the walls. The geometry is the secret; the shadow it
    // casts is the thing everybody is playing with, and the DM needs it to
    // see what the table can see.
    let mut state = fog_room(60.0);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut player = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut dm);
    drain(&mut player);

    state.handle(ClientId(1), between(false));

    for (who, frames) in [
        ("the DM", drain(&mut dm)),
        ("the table", drain(&mut player)),
    ] {
        assert!(
            frames
                .iter()
                .any(|msg| matches!(msg, ServerMsg::FogChanged { .. })),
            "{who} should have been told the fog moved, got {frames:?}"
        );
    }
}

#[test]
fn explored_terrain_is_remembered_and_the_creatures_on_it_are_not() {
    // Terrain gates on `known`, tokens gate on `visible`. The party walks
    // away and keeps the map; the ogre standing on it goes.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(sees_the_ogre(&state));
    let lit = state.revealed.len();

    state.handle(
        ClientId(1),
        fogged(set_map("/assets/map.png", 64.0, 0.0, 0.0), 10.0),
    );

    assert!(!sees_the_ogre(&state), "out of the new, shorter reach");
    assert!(
        state.revealed.len() >= lit,
        "explored terrain only ever grows within one map"
    );
}

#[test]
fn a_new_map_forgets_where_the_party_has_been() {
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    // Out and back, so there is terrain the party remembers and is not
    // standing on. That is the only kind a sweep can be seen to remove.
    walk(&mut state, 20.5);
    walk(&mut state, 1.5);
    assert!(state.revealed.contains(&(20, 1)), "explored on the way");

    state.handle(
        ClientId(1),
        fogged(set_map("/uploads/cave.webp", 64.0, 0.0, 0.0), 30.0),
    );

    // Swept, then immediately re-lit from where the tokens are standing.
    assert!(
        !state.revealed.contains(&(20, 1)),
        "a fresh map starts dark"
    );
    assert!(
        state.revealed.contains(&(1, 1)),
        "except where somebody is standing"
    );
}

#[test]
fn moving_the_lattice_forgets_it_and_changing_the_radius_does_not() {
    // Where fog differs from the walls it is swept beside. A wall is image
    // pixels and still traces the same painted line after a recalibration;
    // these are cells, and the squares themselves have just moved.
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    walk(&mut state, 20.5);
    walk(&mut state, 1.5);
    assert!(state.revealed.contains(&(20, 1)));

    state.handle(
        ClientId(1),
        fogged(set_map("/assets/map.png", 64.0, 0.0, 0.0), 90.0),
    );
    assert!(
        state.revealed.contains(&(20, 1)),
        "a longer torch is not a reason to forget the dungeon"
    );

    state.handle(
        ClientId(1),
        fogged(set_map("/assets/map.png", 96.0, 0.0, 0.0), 90.0),
    );
    assert!(
        !state.revealed.contains(&(20, 1)),
        "a moved lattice throws the old answer away and starts again"
    );
}

#[test]
fn the_two_reasons_a_token_is_unseen_compose_with_the_third() {
    // `hidden`, `staged_only` and now line of sight. Anything that filters on
    // some of them and forgets the rest is a leak.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(sees_the_ogre(&state), "lit and not hidden");

    let ogre = token(&state, "m");
    state.handle(ClientId(1), set_hidden(&ogre, true));
    assert!(!sees_the_ogre(&state), "lit, and hidden anyway");
}

#[test]
fn a_creature_that_walks_out_of_sight_loses_its_row_on_the_tables_panel() {
    // A feature that hides something and leaves it named in a panel hasn't
    // hidden it. That holds for `hidden`, and just as much for a monster the
    // party can no longer see.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("m"),
            value: 14,
        },
    );
    assert_eq!(state.initiative_for(&as_player("saelyn")).entries.len(), 1);

    state.handle(ClientId(1), between(false));
    assert_eq!(
        state.initiative_for(&as_player("saelyn")).entries.len(),
        0,
        "the row goes with the creature"
    );
    assert_eq!(
        state.initiative_for(&Identity::Dm).entries.len(),
        1,
        "and stays on the DM's panel"
    );
}

#[test]
fn an_aura_on_a_creature_in_the_dark_is_not_sent() {
    // The anchored-shape arm of `shapes_for` asks `unseen_by`, so line
    // of sight is covered without another line.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Token(TokenId::new("m")),
            to: Pos { x: 4.0, y: 0.0 },
            color: "#ff8c42e6".to_owned(),
            points: Vec::new(),
        },
    );
    assert_eq!(state.shapes_for(&as_player("saelyn")).len(), 1);

    state.handle(ClientId(1), between(false));
    assert_eq!(
        state.shapes_for(&as_player("saelyn")).len(),
        0,
        "an aura on a monster in the dark is that monster's position in colour"
    );
    assert_eq!(state.shapes_for(&Identity::Dm).len(), 1);
}

#[test]
fn renaming_a_creature_in_the_dark_tells_the_table_nothing() {
    // `held_by` must be read through `unseen_by`, not `Token::unseen`. Otherwise
    // an edit to a monster the party can't see sends them a `TokenRemoved`
    // naming an id they never held, which announces that the id exists.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    assert!(!sees_the_ogre(&state));
    drain(&mut rx);

    let mut renamed = token(&state, "m");
    renamed.name = "Ogre Chieftain".to_owned();
    state.handle(ClientId(1), edit(&renamed));

    let frames = drain(&mut rx);
    assert!(
        frames.is_empty(),
        "a creature they cannot see is not news whatever the DM does to it, got {frames:?}"
    );
}

#[test]
fn a_player_token_is_always_visible_to_the_table_and_always_a_torch() {
    // No rule needed: a player's token is a vision source, so the cell it
    // stands in is lit by it. That is also how handing a token to a player
    // grants sight with no extra rule.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));

    let mut handed = token(&state, "m");
    handed.owner = Owner::Player(PlayerId::new("cleodara"));
    state.handle(ClientId(1), edit(&handed));

    assert!(
        sees_the_ogre(&state),
        "a token somebody owns is on their board wherever it stands"
    );
    assert!(
        state.visible.contains(&(5, 1)),
        "and lights the square it is in"
    );
}

#[test]
fn a_hidden_player_token_lights_nothing() {
    // It is off the board as far as the table is concerned, and a creature
    // nobody can see lighting the room for everybody would want explaining.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let player = token(&state, "p");
    state.handle(ClientId(1), set_hidden(&player, true));

    assert!(state.visible.is_empty(), "no torches left");
    assert!(!sees_the_ogre(&state));
}

#[test]
fn the_play_area_bounds_what_the_party_can_explore() {
    // An implicit wall: vision doesn't spill into the void off the edge of the
    // map, and nothing in the wall editor produces that boundary because it
    // is already on `MapInfo`.
    let mut state = fog_room(200.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(state.revealed.contains(&(20, 1)), "unbounded to begin with");

    state.handle(
        ClientId(1),
        ClientMsg::SetMap {
            url: "/assets/map.png".to_owned(),
            grid_px: 64.0,
            offset_x: 0.0,
            offset_y: 0.0,
            grid_color: "#ffffff52".to_owned(),
            play_area: rect(0.0, 0.0, 640.0, 640.0),
            fog: true,
            vision_ft: 200.0,
            lighting: Lighting::Dynamic,
            grid_shape: GridShape::Square,
            staged: false,
        },
    );

    assert!(state.revealed.contains(&(5, 1)), "inside the board");
    assert!(
        !state.revealed.contains(&(20, 1)),
        "and nothing beyond its edge"
    );
}

#[test]
fn an_unusable_vision_radius_is_refused() {
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));

    // The last is the one `finite` exists for: `1e39` is a perfectly good
    // `f64` and narrowing it to `f32` gives infinity, which serializes to
    // `null` and then refuses to load back.
    for bad in [0.0, -30.0, fog::MAX_VISION_FT + 1.0, 1e39_f64 as f32] {
        assert!(
            state
                .check(
                    ClientId(1),
                    &fogged(set_map("/assets/map.png", 64.0, 0.0, 0.0), bad)
                )
                .is_err(),
            "{bad} feet should have been refused"
        );
    }
    assert!(
        state
            .check(
                ClientId(1),
                &fogged(set_map("/assets/map.png", 64.0, 0.0, 0.0), 30.0)
            )
            .is_ok()
    );
}

#[test]
fn the_fog_survives_the_save_file() {
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let explored = state.revealed.clone();

    // Straight out of the constructor, before `spawn`'s recompute. That is the
    // only place the two halves can be told apart.
    let cold = RoomState::restored(state.to_saved(), SECRET.to_owned(), roster_from(&ROSTER));
    assert_eq!(cold.revealed, explored, "explored terrain is on disk");
    assert!(cold.visible.is_empty(), "and sight is not");
    assert!(cold.shown.is_empty(), "nor is what the table was holding");

    let restored = reboot(state.to_saved());

    assert_eq!(restored.revealed, explored, "still on disk after the boot");
    assert_eq!(
        restored.visible, state.visible,
        "and sight comes back derived, from the tokens the same file holds"
    );
    assert_eq!(
        restored.shown, state.shown,
        "with what the table can see of them, or the first command after a          restart would report every token as newly appeared"
    );
}

// --- room lighting ---------------------------------------------------------

/// The live map recalibrated to itself with the lights worked out a room at a
/// time. The URL and the grid are the ones `fog_room` is already on, so this is
/// a recalibration, not a load, and it sweeps nothing. One of the tests below
/// depends on that.
fn light_rooms(state: &mut RoomState, dm: ClientId, vision_ft: f32) {
    state.handle(
        dm,
        room_lit(fogged(
            set_map("/assets/map.png", 64.0, 0.0, 0.0),
            vision_ft,
        )),
    );
}

/// A spur of masonry between the viewer and the ogre in `fog_room`, blocking the
/// straight line along row 1 and leaving the way round it open at row 2.
fn spur() -> ClientMsg {
    wall(256.0, 0.0, 256.0, 128.0, false)
}

/// The same dividing line carried past anywhere a fill could reach, with a door
/// hung in it on **row 1**, the row both tokens stand on.
///
/// It has to run that far because this map has no play area: a fill walks, so a
/// wall it can go round the end of is a wall it goes round. That makes the mode
/// fail visibly instead of silently.
///
/// The door is on the sight line because the flood doesn't pass open doors.
/// What an open door hands over is the ray through it, so a door hung anywhere
/// else changes nothing and this test would show no difference.
fn barrier() -> [ClientMsg; 3] {
    [
        wall(256.0, -1280.0, 256.0, 64.0, false),
        wall(256.0, 64.0, 256.0, 128.0, true),
        wall(256.0, 128.0, 256.0, 1280.0, false),
    ]
}

#[test]
fn the_mode_is_the_maps_and_switching_it_forgets_nothing() {
    // A lighting change is no reason for the party to forget the dungeon, any
    // more than turning the radius up is: `sweep_board` asks about the board's
    // shape, and this changes none of it.
    let mut state = fog_room(60.0);
    let dm = join_as_dm(&mut state, ClientId(1));
    let explored = state.revealed.clone();
    assert!(!explored.is_empty());

    light_rooms(&mut state, ClientId(1), 60.0);
    assert_eq!(state.map.lighting, Lighting::Room);
    assert!(
        explored.iter().all(|cell| state.revealed.contains(cell)),
        "everywhere the party had been is still theirs"
    );
    drop(dm);
}

#[test]
fn the_room_reaches_a_creature_the_rays_cannot() {
    // Room lighting in one test, asked of the room instead of the geometry:
    // the same wall, the same two tokens, and the mode is the only difference
    // between the table holding the ogre and not.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), spur());
    assert!(!sees_the_ogre(&state), "no straight line reaches it");

    light_rooms(&mut state, ClientId(1), 60.0);
    assert!(
        sees_the_ogre(&state),
        "and a walk round the end of the spur does"
    );
}

#[test]
fn a_shut_door_seals_the_room_and_the_table_is_told_when_it_swings() {
    // What the mode adds past the reveal itself: a door changes what the table
    // sees. Both halves are asserted from the table's side (the creature that
    // never arrived, and the frames that carry it when it does).
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    light_rooms(&mut state, ClientId(1), 60.0);

    for segment in barrier() {
        state.handle(ClientId(1), segment);
    }
    let door = state
        .walls
        .iter()
        .find(|w| matches!(w.kind, WallKind::Door(_)))
        .expect("a door")
        .id
        .clone();

    let mut player = join_as_player(&mut state, ClientId(2), "saelyn");
    assert!(!sees_the_ogre(&state), "a shut door genuinely seals a room");
    drain(&mut player);

    state.handle(ClientId(1), swing(door));
    let frames = drain(&mut player);
    assert!(
        sees_the_ogre(&state),
        "and opening it lets the sight through"
    );
    // The half that says which of the two it let through. The flood bounds on
    // the door whatever it is swung to, so what arrives is the ray along row 1
    // and not the room around it. A creature standing three squares off that
    // line is still in the dark.
    assert!(
        !state.visible.contains(&(4, 4)),
        "an opened door is a doorway, not the room behind it"
    );
    assert!(
        frames
            .iter()
            .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.name == "Ogre")),
        "the table is sent the creature the room just handed them, got {frames:?}"
    );
    assert!(
        frames
            .iter()
            .all(|msg| !matches!(msg, ServerMsg::WallsChanged { .. })),
        "and never the door that did it, got {frames:?}"
    );
}

#[test]
fn a_room_bigger_than_the_radius_stops_at_the_radius() {
    // The bound that keeps `vision_ft` meaningful in both modes instead of
    // dead in one. A hall that lights short needs its map's radius raised, not
    // a second number.
    let mut state = fog_room(15.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), ClientMsg::ResetFog);
    light_rooms(&mut state, ClientId(1), 15.0);

    assert!(
        state.visible.contains(&(4, 1)),
        "three cells is fifteen feet"
    );
    assert!(
        !state.visible.contains(&(5, 1)),
        "and an unwalled board does not light to the horizon"
    );
}

// --- one cell of fringe past the wall ------------------------------------

/// The dividing wall traced, and then the fog started over: `fog_room` lights
/// the room before anything is in the way and `revealed` is memory, so without
/// the reset the party is still holding the far side from before the masonry
/// existed and every assertion below passes for the wrong reason.
fn walled_room() -> (RoomState, mpsc::Receiver<ServerMsg>) {
    let mut state = fog_room(60.0);
    let dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(false));
    state.handle(ClientId(1), ClientMsg::ResetFog);
    (state, dm)
}

#[test]
fn the_table_is_shown_one_cell_of_ground_past_the_wall() {
    // `snapToCorner` puts walls between cell centres, so the last cell a ray
    // reaches is the floor inside the room and the drawn wall is past it. Fog
    // stopping there shows the table floor, then nothing, and the room looks
    // like a hole.
    let (state, _dm) = walled_room();

    assert!(state.visible.contains(&(3, 1)), "the floor inside the room");
    assert!(
        state.known.contains(&(4, 1)),
        "and the masonry the rays stop at"
    );
    assert!(
        !state.revealed.contains(&(4, 1)),
        "a mask over the memory, never a write into it"
    );
    assert!(
        !state.visible.contains(&(4, 1)),
        "and terrain only — explored ground, not sight"
    );
}

#[test]
fn a_creature_standing_in_the_fringe_is_still_not_on_the_tables_board() {
    // The limit on what the fringe may do. Terrain gates on `known` and
    // creatures gate on `visible`; widening the first and not the second is
    // what keeps an ogre pressed against the far side of a wall a surprise.
    let (mut state, _dm) = walled_room();
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut rx);

    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("m"),
            x: 4.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );

    assert!(state.known.contains(&(4, 1)), "ground the table is shown");
    assert!(!sees_the_ogre(&state), "and nothing standing on it");

    let frames = drain(&mut rx);
    let spoke_of_it = frames.iter().any(|msg| match msg {
        ServerMsg::TokenMoved { id, .. } | ServerMsg::TokenRemoved { id } => id.0 == "m",
        ServerMsg::TokenChanged { token } => token.id.0 == "m",
        _ => false,
    });
    assert!(
        !spoke_of_it,
        "a fringe cell is ground and not news about what is in it, got {frames:?}"
    );
}

#[test]
fn a_blacked_out_cell_is_still_dark_with_explored_ground_beside_it() {
    // `Dark` is a ceiling and the fringe is a floor, and the mask goes on
    // afterwards. A DM who paints the far side of a wall dark and finds the
    // fringe handing it straight back has not painted anything.
    let (mut state, _dm) = walled_room();
    assert!(state.known.contains(&(4, 1)), "fringed to begin with");

    state.handle(ClientId(1), paint(&[(4, 1)], Some(Override::Dark)));

    assert!(!state.known.contains(&(4, 1)));
}

#[test]
fn the_fringe_stops_at_the_edge_of_the_board() {
    // The bound the sweep already takes, for the same reason: the void off the
    // edge is not somewhere the party explores, and one cell out there is a
    // cell in the packed rectangle from then on.
    let mut state = fog_room(200.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetMap {
            url: "/assets/map.png".to_owned(),
            grid_px: 64.0,
            offset_x: 0.0,
            offset_y: 0.0,
            grid_color: "#ffffff52".to_owned(),
            play_area: rect(0.0, 0.0, 640.0, 640.0),
            fog: true,
            vision_ft: 200.0,
            lighting: Lighting::Dynamic,
            grid_shape: GridShape::Square,
            staged: false,
        },
    );

    assert!(state.known.contains(&(9, 1)), "the last cell on the board");
    assert!(
        !state.known.contains(&(10, 1)),
        "and no fringe past its edge"
    );
    assert!(!state.known.contains(&(1, -1)), "in either direction");
}

#[test]
fn the_fringe_is_derived_and_never_reaches_the_save_file() {
    let (state, _dm) = walled_room();
    assert!(state.known.contains(&(4, 1)));

    let restored = reboot(state.to_saved());

    assert!(
        !restored.revealed.contains(&(4, 1)),
        "memory is rays, so a fringe cell cannot bake itself into one"
    );
    assert!(
        restored.revealed.contains(&(3, 1)),
        "and the ground the rays did reach is still there"
    );
}

// --- the DM's manual override -------------------------------------------

#[test]
fn blacking_out_a_cell_takes_the_creature_standing_in_it_off_the_table() {
    // `Dark` subtracts from `visible`, so `in_sight` says no and the token
    // leaves through the same path `hidden` uses. A DM who blacks out a room
    // and finds the monster still on the table's board hasn't blacked out the
    // room.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(sees_the_ogre(&state), "lit to begin with");

    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Dark)));

    assert!(!sees_the_ogre(&state));
    assert!(
        names(&state.snapshot_for(&Identity::Dm)).contains(&"Ogre"),
        "and the DM still sees their own monster, as they do through any fog"
    );
}

#[test]
fn a_blacked_out_cell_stays_dark_with_a_torch_standing_in_it() {
    // **Why this is a mask and not a write into `revealed`.** A hide that
    // only cleared the set would be undone the next time somebody carried a
    // light past, which a manual override must never do, and the failure
    // would look like a bug in the raycast.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Dark)));

    walk(&mut state, 5.5);

    assert!(
        !state.visible.contains(&OGRE_CELL),
        "the party is standing in it and it is still dark"
    );
    assert!(
        !state.known.contains(&OGRE_CELL),
        "and it did not enter what the table is shown by the back door either"
    );
    // The other direction: the light really did reach the cell, and the mask
    // hides that instead of destroying it. Subtracting from memory here would
    // make a `Dark` fill impossible to lift.
    assert!(
        state.revealed.contains(&OGRE_CELL),
        "the rays are not what the DM is editing"
    );

    state.handle(ClientId(1), paint(&[OGRE_CELL], None));

    assert!(
        state.known.contains(&OGRE_CELL),
        "so lifting the paint gives back the ground they walked over"
    );
}

#[test]
fn clearing_a_ground_fill_takes_the_ground_back() {
    // The mirror of the test above. If an `Explored` paint were unioned into
    // `revealed` on every pass, the cells would outlive the paint that put
    // them there and a fill would be permanent. One stray click through a gap
    // in a traced wall could hand over the whole dungeon with no way back
    // short of reloading the map.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), paint(&[(9, 1)], Some(Override::Explored)));

    assert!(state.known.contains(&(9, 1)), "the table is shown it");
    assert!(
        !state.revealed.contains(&(9, 1)),
        "and nothing but a ray reaches memory"
    );

    state.handle(ClientId(1), paint(&[(9, 1)], None));

    assert!(
        !state.known.contains(&(9, 1)),
        "handing the cell back un-paints it rather than leaving it explored forever"
    );
}

#[test]
fn the_two_reveal_brushes_differ_over_who_is_standing_there() {
    // Terrain and creatures, which is the split the feature is built
    // on. `Explored` hands over the ground; `Lit` hands over what is on it.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(!sees_the_ogre(&state), "four cells away with two of vision");

    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Explored)));
    assert!(state.known.contains(&OGRE_CELL), "the ground is theirs");
    assert!(
        !sees_the_ogre(&state),
        "and the ambush standing on it is not"
    );

    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Lit)));
    assert!(
        sees_the_ogre(&state),
        "which is what the other brush is for"
    );
}

#[test]
fn revealing_the_ground_does_not_dim_a_square_the_rays_already_lit() {
    // `Explored` is a floor, not an assignment. Making it demote a lit cell
    // would be a fifth state ("the room but not the ambush in it"), and that
    // is what `hidden` is for.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Explored)));

    assert!(state.visible.contains(&OGRE_CELL));
    assert!(sees_the_ogre(&state));
}

#[test]
fn a_player_keeps_their_own_token_in_a_blacked_out_room() {
    // `in_sight` returns true early for anything a player owns, so `Dark`
    // stops short of deleting the party from their own screens: a magical
    // darkness they can't see out of is still one they are in.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), paint(&[(1, 1)], Some(Override::Dark)));

    assert!(
        names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Saelyn"),
        "the party is still standing where they are standing"
    );
    assert!(
        !state.visible.contains(&(1, 1)),
        "on ground the table is nonetheless shown as dark"
    );
}

#[test]
fn handing_a_cell_back_is_a_removal_and_the_rays_answer_again() {
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Dark)));
    assert!(!sees_the_ogre(&state));

    state.handle(ClientId(1), paint(&[OGRE_CELL], None));

    assert!(
        state.overrides.is_empty(),
        "`Auto` is the absence of an entry, not a fourth one"
    );
    assert!(sees_the_ogre(&state), "and sight decides the cell again");
}

#[test]
fn resetting_forgets_the_evening_and_the_paint_together() {
    // "This map has not been seen yet" is one gesture, so it is one command.
    // Clearing the paint alone leaves a dungeon the party has already walked
    // through, which is not a reset of anything the DM was looking at.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), paint(&[(9, 1)], Some(Override::Explored)));
    walk(&mut state, 5.5);
    walk(&mut state, 1.5);

    assert!(state.known.contains(&(5, 1)), "explored on the way past");
    assert!(!state.visible.contains(&(5, 1)), "and out of sight again");

    state.handle(ClientId(1), ClientMsg::ResetFog);

    assert!(state.overrides.is_empty(), "the paint goes");
    assert!(!state.known.contains(&(9, 1)), "the ground it handed over");
    assert!(!state.known.contains(&(5, 1)), "the evening's exploring");
    assert!(
        state.known.contains(&(1, 1)),
        "and what is left is what the party can see from where they stand"
    );
}

#[test]
fn resetting_the_fog_tells_the_table_and_not_only_the_dm() {
    // `OverridesChanged` reaches the DM alone, so the table's only news is the
    // `FogChanged` beside it, and the board going dark under them is the one
    // frame they most need.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    walk(&mut state, 5.5);
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut rx);

    state.handle(ClientId(1), ClientMsg::ResetFog);

    let frames = drain(&mut rx);
    assert!(
        frames
            .iter()
            .any(|m| matches!(m, ServerMsg::FogChanged { .. })),
        "expected the table to be told, got {frames:?}"
    );
}

#[test]
fn the_override_reaches_the_dm_or_nobody() {
    // The walls' rule again. What the DM decided is theirs; the difference it
    // made is what the table is sent, in the `FogChanged` beside it.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Dark)));

    assert_eq!(
        state.snapshot_for(&as_player("saelyn")).overrides,
        OverrideView::default(),
        "empty is both 'nothing painted' and 'you are not the DM'"
    );
    assert_ne!(
        state.snapshot_for(&Identity::Dm).overrides,
        OverrideView::default()
    );

    let frames = drain(&mut rx);
    assert!(
        !frames
            .iter()
            .any(|m| matches!(m, ServerMsg::OverridesChanged { .. })),
        "not even an empty one: the frame itself would say the DM did something"
    );
    assert!(
        frames
            .iter()
            .any(|m| matches!(m, ServerMsg::FogChanged { .. })),
        "what they are owed is the shadow it cast, got {frames:?}"
    );
}

#[test]
fn painting_over_ground_nobody_could_see_is_no_news_at_all() {
    // The gate on `FogChanged`. A DM blacking out a corner of the map the
    // party has never been near changes nothing the table holds, and a frame
    // saying so would tell them when the DM was working.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut rx);

    state.handle(ClientId(1), paint(&[(30, 30)], Some(Override::Dark)));

    let frames = drain(&mut rx);
    assert!(frames.is_empty(), "expected silence, got {frames:?}");
}

#[test]
fn only_the_dm_may_override_the_fog() {
    let mut state = fog_room(60.0);
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    for msg in [
        paint(&[OGRE_CELL], Some(Override::Lit)),
        ClientMsg::ResetFog,
    ] {
        assert!(state.check(ClientId(2), &msg).is_err());
    }
}

#[test]
fn an_override_is_refused_where_it_could_do_nothing() {
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));

    assert!(
        state
            .check(ClientId(1), &paint(&[], Some(Override::Dark)))
            .is_err(),
        "no cells at all"
    );

    let too_many: Vec<Cell> = (0..=MAX_OVERRIDE_CELLS as i32).map(|i| (i, 0)).collect();
    assert!(
        state
            .check(ClientId(1), &paint(&too_many, Some(Override::Dark)))
            .is_err(),
        "a fill that escaped through a gap the DM did not notice"
    );

    // Clipped for the reason the sweep in `fog.rs` clips itself: one cell out
    // there puts the whole map's worth of characters in the packed rectangle.
    assert!(
        state
            .check(ClientId(1), &paint(&[(9_000_000, 0)], Some(Override::Dark)))
            .is_err(),
        "and one cell a million squares away"
    );

    // Refused rather than stored and ignored: an override on an unfogged map
    // can have no effect, and the panel greys itself for the same reason.
    state.map.fog = false;
    assert!(
        state
            .check(ClientId(1), &paint(&[OGRE_CELL], Some(Override::Dark)))
            .is_err()
    );
}

/// The frame-size check for the largest override.
///
/// Every other test here drives `check` directly, which is the only way to see
/// what a client was not sent. It is also a way to pass green over a path
/// production can't reach: if `MAX_OVERRIDE_CELLS` doesn't fit in a 16 KiB
/// frame, the refusal the test above asserts is undeliverable, because the
/// socket dies on the read and the DM's page reloads instead.
///
/// So this one asserts on the bytes, not on the room. Worst case is what
/// matters (four-digit coordinates, `[1234,5678],` at 12 bytes), because a cap
/// that only fits at two digits fails on a big map, which is the map a fill
/// that size comes from.
///
/// It builds the frame instead of serialising a `ClientMsg`, which is inbound
/// and so has no `Serialize`. That is also the better test: the text below is
/// what a client actually puts on the wire, and deserialising it back proves
/// the shape being measured is the real one.
#[test]
fn largest_override_fits_in_a_frame() {
    // Four digits in both coordinates, and every cell distinct, so nothing here
    // is cheaper to serialise than the real thing.
    let cells: Vec<Cell> = (0..MAX_OVERRIDE_CELLS)
        .map(|i| (1000 + (i % 9000) as i32, 1000 + (i / 9000) as i32))
        .collect();
    let frame = serde_json::json!({
        "type": "set_fog_override",
        "cells": cells,
        "state": Override::Dark,
        "staged": false,
    });
    let bytes = serde_json::to_vec(&frame).expect("encodes");

    // The shape above is the server's own, not this test's idea of it.
    let parsed: ClientMsg = serde_json::from_slice(&bytes).expect("the server parses its own");
    assert!(
        matches!(parsed, ClientMsg::SetFogOverride { cells, .. } if cells.len() == MAX_OVERRIDE_CELLS),
        "the frame being measured is the command being capped",
    );

    assert!(
        bytes.len() <= crate::MAX_WS_MESSAGE_BYTES,
        "the largest legal fill is {} bytes and the frame cap is {} — the DM's \
         socket would die on the read before `check` could name the refusal",
        bytes.len(),
        crate::MAX_WS_MESSAGE_BYTES,
    );

    // And the other way round, because a cap far under the frame is a fill the
    // DM is refused for no reason. Half is the loosest bound worth asserting.
    assert!(
        bytes.len() * 2 >= crate::MAX_WS_MESSAGE_BYTES,
        "the cap has drifted well under what a frame holds ({} of {})",
        bytes.len(),
        crate::MAX_WS_MESSAGE_BYTES,
    );
}

#[test]
fn moving_the_lattice_forgets_the_overrides_and_a_new_map_does_too() {
    // Cells, like the two sets they mask, so the squares moving underneath
    // them is enough to clear them. The walls stored beside them trace the art
    // and survive a recalibration.
    for (what, msg) in [
        (
            "a recalibration",
            fogged(set_map("/assets/map.png", 96.0, 0.0, 0.0), 60.0),
        ),
        (
            "a new map",
            fogged(set_map("/uploads/next.jpg", 64.0, 0.0, 0.0), 60.0),
        ),
    ] {
        let mut state = fog_room(60.0);
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Dark)));
        assert!(!state.overrides.is_empty());

        state.handle(ClientId(1), msg);
        assert!(state.overrides.is_empty(), "{what} should sweep them");
    }
}

#[test]
fn the_overrides_survive_the_save_file() {
    // The mirror image of the fog beside them. Sight is derived from what the
    // file already holds; what somebody decided is derivable from nothing, so
    // losing it would lose the work.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        paint(&[OGRE_CELL, (9, 9)], Some(Override::Dark)),
    );
    state.handle(ClientId(1), paint(&[(2, 2)], Some(Override::Lit)));

    let restored = reboot(state.to_saved());

    assert_eq!(restored.overrides, state.overrides);
    assert!(
        !sees_the_ogre(&restored),
        "and they are applied again on boot, not merely stored"
    );
}

// --- the staged board's paint ---------------------------------------------

/// A fogged map in the staged slot, with the live board left as it was.
fn stage_fogged(state: &mut RoomState, dm: ClientId) {
    state.handle(
        dm,
        staged(fogged(set_map("/uploads/crypt.png", 64.0, 0.0, 0.0), 60.0)),
    );
}

#[test]
fn paint_on_the_staged_board_does_not_touch_the_live_one() {
    // Two boards, two masks, and the flag on the command is the only thing
    // telling them apart, as it is for a token's position and its plan.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        staged(paint(&[OGRE_CELL], Some(Override::Dark))),
    );

    assert!(
        state.overrides.is_empty(),
        "the board the table is playing on was never painted"
    );
    assert!(
        sees_the_ogre(&state),
        "and nothing about what they can see changed"
    );
    assert_eq!(
        state.staged.as_ref().map(|b| b.overrides.len()),
        Some(1),
        "the paint landed on the map being prepared"
    );
}

#[test]
fn painting_the_staged_board_moves_no_fog_at_all() {
    // The live board's paint is never the only news: `refresh_fog` reports the
    // shadow it cast beside it. The staged board's is the only news, and
    // correctly: no ray has been cast on a map the table hasn't been shown.
    let mut state = fog_room(60.0);
    let mut dm_rx = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));
    drain(&mut dm_rx);

    state.handle(ClientId(1), staged(paint(&[(2, 2)], Some(Override::Lit))));

    let frames = drain(&mut dm_rx);
    assert!(
        frames
            .iter()
            .any(|m| matches!(m, ServerMsg::OverridesChanged { staged: true, .. })),
        "the DM is told what they painted: {frames:?}"
    );
    assert!(
        !frames
            .iter()
            .any(|m| matches!(m, ServerMsg::FogChanged { .. })),
        "and nothing claims the table's view moved: {frames:?}"
    );
}

#[test]
fn the_staged_fog_switch_is_what_a_staged_paint_is_checked_against() {
    // What staging changes in this refusal: a fogged staged map may be painted
    // while the unfogged live board under it may not, which is the DM
    // preparing a dungeon while the table is in a meadow.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(!state.map.fog, "the live board is a meadow");

    stage_fogged(&mut state, ClientId(1));

    assert!(
        state
            .check(ClientId(1), &paint(&[(1, 1)], Some(Override::Dark)))
            .is_err(),
        "there is no fog on the board to override"
    );
    assert!(
        state
            .check(ClientId(1), &staged(paint(&[(1, 1)], Some(Override::Dark))))
            .is_ok(),
        "and there is on the map being prepared"
    );
}

#[test]
fn promoting_hands_the_party_the_paint_prepared_for_them() {
    // The reason a staged override is worth having: the room is blacked out
    // before anybody has seen the map, rather than the DM racing to paint it
    // over while the table watches.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));
    // The ogre's cell, blacked out in advance. On the live board the party can
    // see it right now.
    state.handle(
        ClientId(1),
        staged(paint(&[OGRE_CELL], Some(Override::Dark))),
    );
    assert!(sees_the_ogre(&state), "still true on the board they are on");

    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    assert_eq!(
        state.overrides.get(&OGRE_CELL),
        Some(&Override::Dark),
        "the paint came across with the map"
    );
    assert!(
        !sees_the_ogre(&state),
        "and it is applied the moment the map lands, not a beat later"
    );
    assert!(state.staged.is_none());
}

#[test]
fn a_staged_recalibration_drops_the_paint_and_keeps_the_walls() {
    // The live board's rule, mirrored, which is the argument for the two slots
    // holding the same three things. A wall is image pixels and still traces
    // the same painted line; an override is a cell whose square has just moved.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)),
    );
    state.handle(ClientId(1), staged(paint(&[(1, 1)], Some(Override::Dark))));

    // Same URL, different grid: a recalibration.
    state.handle(
        ClientId(1),
        staged(fogged(set_map("/uploads/crypt.png", 96.0, 0.0, 0.0), 60.0)),
    );

    let board = state.staged.as_ref().expect("still staged");
    assert_eq!(board.map.grid_px, 96.0, "the correction was applied");
    assert_eq!(board.walls.len(), 1, "the tracing survived it");
    assert!(
        board.overrides.is_empty(),
        "and the paint did not: those cells are not where they were"
    );
}

#[test]
fn a_staged_load_sweeps_what_was_prepared_for_the_last_one() {
    // `shelve_tokens`' rule, reaching the other two things the slot now
    // holds. A different map is a different next room, and none of the tracing
    // done for the last one means anything on it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)),
    );
    state.handle(ClientId(1), staged(paint(&[(1, 1)], Some(Override::Dark))));

    state.handle(
        ClientId(1),
        staged(fogged(set_map("/uploads/other.png", 64.0, 0.0, 0.0), 60.0)),
    );

    let board = state.staged.as_ref().expect("the new map is staged");
    assert_eq!(board.map.url, "/uploads/other.png");
    assert!(board.walls.is_empty(), "a different dungeon");
    assert!(board.overrides.is_empty());
}

#[test]
fn discarding_the_staged_map_takes_its_walls_and_its_paint_with_it() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)),
    );
    state.handle(ClientId(1), staged(paint(&[(1, 1)], Some(Override::Dark))));

    state.handle(ClientId(1), ClientMsg::ClearStaged);

    assert!(state.staged.is_none());
    assert!(state.walls.is_empty(), "and none of it fell onto the board");
    assert!(state.overrides.is_empty());
}

#[test]
fn a_player_is_never_sent_the_staged_boards_paint() {
    // The override travels like the walls, not like the fog, and staging
    // doesn't change that: it is what the DM authored, on a map the table
    // hasn't been shown, which is the same rule twice over.
    let mut state = fog_room(60.0);
    let dm = ClientId(1);
    let mut _dm_rx = join_as_dm(&mut state, dm);
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    stage_fogged(&mut state, dm);
    state.handle(dm, staged(paint(&[(1, 1)], Some(Override::Dark))));

    assert!(
        state.snapshot_for(&as_player("saelyn")).staged.is_none(),
        "invariant 3: the whole slot is absent, paint included"
    );
    assert!(
        state
            .message_for(ClientId(2), dm, &Event::OverridesChanged { staged: true })
            .is_none()
    );
    assert!(
        drain(&mut saelyn).is_empty(),
        "a player was told something about the next dungeon"
    );
}

#[test]
fn a_creature_dragged_out_of_sight_is_taken_off_the_tables_board() {
    // The DM drags a monster from the light into the dark. The table must not
    // be left with it standing at the last cell a drag frame reached them.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(false));
    // In front of the wall, where the party can see it.
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("m"),
            x: 2.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    assert!(sees_the_ogre(&state), "visible before the drag");
    drain(&mut rx);

    // A drag, as a real one arrives: frames on the way, then the drop.
    for x in [3.0, 4.0, 5.0] {
        state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("m"),
                x,
                y: 1.5,
                dragging: true,
                staged: false,
            },
        );
    }
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("m"),
            x: 5.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );

    assert!(!sees_the_ogre(&state), "behind the wall now");
    let frames = drain(&mut rx);
    assert!(
        frames
            .iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "m")),
        "it has to leave their board rather than stand where it was last seen, got {frames:?}"
    );
}

#[test]
fn a_creature_dragged_around_in_the_dark_is_still_never_mentioned() {
    // The other half of the one above, and the half that is easy to break
    // fixing it: a `TokenRemoved` naming an id they have never held would
    // announce that the id exists. `held_by` is the only guard, and the
    // record `shown` keeps has to agree with it frame by frame.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(false));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    assert!(!sees_the_ogre(&state), "behind the wall from the start");
    drain(&mut rx);

    for (x, dragging) in [(6.0, true), (7.0, true), (6.5, false)] {
        state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("m"),
                x,
                y: 1.5,
                dragging,
                staged: false,
            },
        );
    }

    let frames = drain(&mut rx);
    assert!(
        frames.is_empty(),
        "nothing at all about a monster they were never shown, got {frames:?}"
    );
}
// --- light sources ------------------------------------------------------

/// A light standing in row 1 at `x`, built the way the DM's panel builds one.
///
/// Through `handle` rather than inserted into the table, so the gate, the
/// recompute and the frames the room decides to send are all in the reading.
fn light_at(name: &str, x: f32, light_ft: f32) -> ClientMsg {
    ClientMsg::CreateToken {
        name: name.to_owned(),
        img: String::new(),
        size: 1.0,
        owner: Owner::Dm,
        x,
        y: 1.5,
        hidden: false,
        hp: None,
        light_ft: Some(light_ft),
        vision_ft: None,
        markers: Vec::new(),
        staged: false,
    }
}

#[test]
fn a_light_the_party_can_see_reaches_further_than_their_own_torches() {
    // The case the feature was asked for, in its own numbers: vision at thirty
    // feet and a brazier at forty. The party cannot *reach* it and can plainly
    // see it, so gating on their radius would answer a question nobody asked.
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));

    assert!(
        !state.visible.contains(&(12, 1)),
        "six cells of vision does not reach eleven"
    );

    state.handle(ClientId(1), light_at("Brazier", 9.5, 30.0));

    assert!(
        state.visible.contains(&(12, 1)),
        "the brazier lights its own surroundings once they can see it"
    );
    assert!(
        state.revealed.contains(&(12, 1)),
        "and it is a ray like any other, so the party remember it"
    );
}

#[test]
fn a_light_behind_a_wall_lights_nothing_and_the_table_is_told_nothing() {
    // The failure that would sink the feature: a DM preparing a dungeon puts a
    // brazier in every room, and ungated the promote hands the table every lit
    // chamber on the level through three walls. `visible` is a flat union of
    // its sources, so the gate has to be applied to the source list.
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(false));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut rx);

    state.handle(ClientId(1), light_at("Brazier", 9.5, 30.0));

    assert!(
        !state.visible.contains(&(12, 1)),
        "no line to it, so it is not a source"
    );
    let frames = drain(&mut rx);
    assert!(
        frames.is_empty(),
        "and nothing about it leaves the room at all, got {frames:?}"
    );
}

#[test]
fn swinging_a_door_open_switches_the_light_behind_it_on() {
    // The gate reading as it is meant to be explained: you see the light, and
    // then you see what it lights. A door is what makes that happen at a table.
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(true));
    let door = state.walls.first().expect("the door").id.clone();
    state.handle(ClientId(1), light_at("Brazier", 9.5, 30.0));

    assert!(!state.visible.contains(&(12, 1)), "traced shut");

    state.handle(ClientId(1), swing(door));
    assert!(
        state.visible.contains(&(12, 1)),
        "and an open one is a line of sight like any other"
    );
}

#[test]
fn a_players_own_vision_replaces_the_maps_radius() {
    // `vision_ft` on a token the party owns is how far that token sees.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(!sees_the_ogre(&state), "two cells does not reach four");

    let mut keen = token(&state, "p");
    keen.vision_ft = Some(60.0);
    state.handle(ClientId(1), edit(&keen));

    assert!(sees_the_ogre(&state), "twelve cells does");
}

#[test]
fn a_lantern_adds_to_its_carriers_sight_and_never_shortens_it() {
    // A player's lantern is a light like a brazier's, gated like one, and it
    // passes because they can see their own token. So it lights past their
    // eyes on a dark map, and a short one on a bright map costs them nothing.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut carrying = token(&state, "p");
    carrying.light_ft = Some(60.0);
    state.handle(ClientId(1), edit(&carrying));
    assert!(
        sees_the_ogre(&state),
        "the lantern reaches what her eyes don't"
    );

    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(sees_the_ogre(&state));
    let mut carrying = token(&state, "p");
    carrying.light_ft = Some(5.0);
    state.handle(ClientId(1), edit(&carrying));
    assert!(
        sees_the_ogre(&state),
        "a five-foot candle doesn't cut sixty feet of sight to five"
    );
}

#[test]
fn only_a_players_token_may_carry_a_vision_radius() {
    // A monster's eyes give the party nothing, so the number would be read by
    // nothing. Both commands, and the edit that hands a token back to the DM.
    let mut state = fog_room(30.0);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let refused = |dm: &mut mpsc::Receiver<ServerMsg>| {
        drain(dm).iter().any(|msg| {
            matches!(msg, ServerMsg::Error { message }
                if message == "only a player's token sees for the table")
        })
    };

    state.handle(
        ClientId(1),
        ClientMsg::CreateToken {
            name: "Owlbear".to_owned(),
            img: String::new(),
            size: 2.0,
            owner: Owner::Dm,
            x: 9.5,
            y: 1.5,
            hidden: false,
            hp: None,
            light_ft: None,
            vision_ft: Some(60.0),
            markers: Vec::new(),
            staged: false,
        },
    );
    assert!(refused(&mut dm), "a create");
    assert!(!state.tokens.values().any(|t| t.name == "Owlbear"));

    let mut ogre = token(&state, "m");
    ogre.vision_ft = Some(60.0);
    state.handle(ClientId(1), edit(&ogre));
    assert!(refused(&mut dm), "an edit");
    assert_eq!(token(&state, "m").vision_ft, None);

    let mut keen = token(&state, "p");
    keen.vision_ft = Some(60.0);
    state.handle(ClientId(1), edit(&keen));
    keen.owner = Owner::Dm;
    state.handle(ClientId(1), edit(&keen));
    assert!(refused(&mut dm), "handing it back without clearing it");
    assert_eq!(
        token(&state, "p").owner,
        Owner::Player(PlayerId::new("saelyn"))
    );
}

#[test]
fn a_players_copy_of_a_token_never_carries_its_vision() {
    // The light's rule, and her own token is the one that has it: a player
    // isn't told even their own number, as with `hp`.
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut keen = token(&state, "p");
    keen.vision_ft = Some(60.0);
    state.handle(ClientId(1), edit(&keen));

    let seen = |view: &RoomView| {
        view.tokens
            .iter()
            .find(|t| t.id.0 == "p")
            .map(|t| t.vision_ft)
    };
    assert_eq!(seen(&state.snapshot_for(&Identity::Dm)), Some(Some(60.0)));
    assert_eq!(seen(&state.snapshot_for(&as_player("saelyn"))), Some(None));

    let told = drain(&mut rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::TokenChanged { token } if token.id.0 == "p" => Some(token.vision_ft),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(told, vec![None], "the delta says as little");
}

#[test]
fn a_light_nobody_can_see_lights_nothing_whoever_is_holding_it() {
    // `!unseen()`, the rule vision uses, applied to lights: a creature off the
    // table's board lighting the room for everybody would want explaining. A
    // staged one is the same sentence about the next map.
    for take_away in [true, false] {
        let mut state = fog_room(30.0);
        let _dm = join_as_dm(&mut state, ClientId(1));
        state.handle(ClientId(1), light_at("Brazier", 9.5, 30.0));
        assert!(state.visible.contains(&(12, 1)), "lit to begin with");

        let brazier = made(&state, "Brazier");
        if take_away {
            state.handle(ClientId(1), set_hidden(&brazier, true));
        } else {
            let Some(token) = state.tokens.get_mut(&brazier.id) else {
                unreachable!("just built")
            };
            token.staged_only = true;
            state.recompute_sight();
        }

        assert!(
            !state.visible.contains(&(12, 1)),
            "hidden: {take_away} left it lighting the board"
        );
    }
}

#[test]
fn one_light_never_switches_on_the_next() {
    // No cascade, and it is the failure the gate exists to prevent arriving one
    // step later: a chain of torches down a corridor would open the level. The
    // gate reads the sight the party has *on their own*, computed before a
    // single light joins the list.
    //
    // The stub runs along the boundary below row 3 and reaches from x = 128 to
    // x = 320, so it crosses the party's diagonal to the far light and misses
    // the near light's own straight drop to it.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), wall(128.0, 256.0, 320.0, 256.0, false));

    // Near, in plain sight of the party, and reaching the far one's square.
    state.handle(ClientId(1), light_at("Near", 5.5, 30.0));
    // Far, around the stub, lighting a stretch only it could light.
    state.handle(
        ClientId(1),
        ClientMsg::CreateToken {
            name: "Far".to_owned(),
            img: String::new(),
            size: 1.0,
            owner: Owner::Dm,
            x: 5.5,
            y: 5.5,
            hidden: false,
            hp: None,
            light_ft: Some(30.0),
            vision_ft: None,
            markers: Vec::new(),
            staged: false,
        },
    );

    assert!(
        state.visible.contains(&(5, 5)),
        "the near light reaches the far one's square"
    );
    assert!(
        !state.visible.contains(&(5, 9)),
        "and the far one stays dark, because being lit is not being seen"
    );
}

#[test]
fn a_players_copy_of_a_token_never_carries_its_light() {
    // What a light does reaches the table as fog; what it is is the DM's
    // authoring, and goes the way the walls go. Both routes out, because
    // filtering every delta correctly and then handing over the whole world on
    // connect is the most common way to leak.
    let mut state = fog_room(30.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), light_at("Brazier", 9.5, 30.0));

    let seen = |view: &RoomView| {
        view.tokens
            .iter()
            .find(|t| t.name == "Brazier")
            .map(|t| t.light_ft)
    };
    assert_eq!(
        seen(&state.snapshot_for(&Identity::Dm)),
        Some(Some(30.0)),
        "the DM's own client is what draws the panel"
    );
    assert_eq!(
        seen(&state.snapshot_for(&as_player("saelyn"))),
        Some(None),
        "and a player is sent the token without its reach"
    );

    let told = drain(&mut rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::TokenChanged { token } if token.name == "Brazier" => Some(token.light_ft),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(told, vec![None], "the delta beside it says as little");
}

// --- split sight ----------------------------------------------------------

/// `fog_room` with a second scout: Torrin's token far down the board, out of
/// the ogre's reach. At thirty feet Saelyn sees the ogre (four cells off) and
/// Torrin doesn't (nearly twelve), so the two players disagree exactly when
/// sight is split.
fn two_scouts(vision: Vision) -> RoomState {
    let mut state = fog_room(30.0);
    state.tokens.insert(
        TokenId::new("q"),
        Token {
            id: TokenId::new("q"),
            name: "Torrin".to_owned(),
            x: 1.5,
            y: 12.5,
            owner: Owner::Player(PlayerId::new("torrin")),
            ..Token::default()
        },
    );
    state.vision = vision;
    state.recompute_sight();
    state
}

/// Whether any of these frames names the ogre, which is what a player who
/// can't see it must never be sent.
fn mentions_the_ogre(frames: &[ServerMsg]) -> bool {
    frames.iter().any(|msg| match msg {
        ServerMsg::TokenChanged { token } => token.id.0 == "m",
        ServerMsg::TokenMoved { id, .. } | ServerMsg::TokenRemoved { id } => id.0 == "m",
        _ => false,
    })
}

#[test]
fn under_party_sight_one_scout_shows_the_whole_table() {
    let state = two_scouts(Vision::Party);
    assert!(names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Ogre"));
    assert!(
        names(&state.snapshot_for(&as_player("torrin"))).contains(&"Ogre"),
        "the default is unchanged: what one party member sees, all of them do"
    );
}

#[test]
fn under_split_sight_only_the_player_who_can_see_it_is_sent_the_monster() {
    let state = two_scouts(Vision::Split);
    assert!(names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Ogre"));

    let torrin = state.snapshot_for(&as_player("torrin"));
    assert!(
        !names(&torrin).contains(&"Ogre"),
        "Torrin's tokens have no sight of it, so his snapshot doesn't carry it"
    );
    assert!(
        !names(&torrin).contains(&"Saelyn"),
        "nor Saelyn, who is as far out of his sight as the ogre"
    );
    assert!(
        names(&torrin).contains(&"Torrin"),
        "but his own token is always on his board"
    );
    assert!(
        names(&state.snapshot_for(&Identity::Dm)).contains(&"Ogre"),
        "and the DM sees their own monsters"
    );
    assert_ne!(
        torrin.fog,
        state.snapshot_for(&as_player("saelyn")).fog,
        "each player's fog is packed against their own sight"
    );
    assert_ne!(
        state.snapshot_for(&Identity::Dm).fog,
        state.snapshot_for(&as_player("saelyn")).fog,
        "the DM's frame is the party's union, which isn't Saelyn's alone"
    );
}

#[test]
fn split_sight_still_shares_what_the_party_has_explored() {
    // Only `visible` splits. Torrin's board shows the ground Saelyn walked,
    // dimmed, so the explored map stays the party's map.
    let state = two_scouts(Vision::Split);
    let party = two_scouts(Vision::Party);
    assert_eq!(state.revealed, party.revealed);
    assert_eq!(state.known, party.known);
    assert_eq!(
        state.visible, party.visible,
        "the union of everyone's sight is the party's sight"
    );
    assert!(
        !state.visible_by[&PlayerId::new("torrin")].contains(&OGRE_CELL),
        "and Torrin's own share of it doesn't reach the ogre"
    );
}

#[test]
fn a_monster_stepping_into_one_players_sight_is_not_announced_to_the_other() {
    let mut state = two_scouts(Vision::Split);
    let _dm = join_as_dm(&mut state, ClientId(1));
    // Off to the east, out of both scouts' sight.
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("m"),
            x: 15.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut saelyn, &mut torrin]);

    // Back to where Saelyn can see it, and nowhere near Torrin.
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("m"),
            x: 5.5,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );

    let hers = drain(&mut saelyn);
    assert!(mentions_the_ogre(&hers), "Saelyn meets it, got {hers:?}");
    let his = drain(&mut torrin);
    assert!(
        !mentions_the_ogre(&his),
        "Torrin is told nothing about it, got {his:?}"
    );
}

#[test]
fn switching_to_split_sight_takes_the_monster_off_the_board_of_whoever_cant_see_it() {
    let mut state = two_scouts(Vision::Party);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut saelyn, &mut torrin]);

    state.handle(
        ClientId(1),
        ClientMsg::SetVision {
            vision: Vision::Split,
        },
    );

    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "m")),
        "Torrin held the ogre through Saelyn's eyes, and loses it, got {his:?}"
    );
    assert!(
        his.iter().any(|msg| matches!(
            msg,
            ServerMsg::VisionChanged {
                vision: Vision::Split
            }
        )),
        "and is told the switch moved, got {his:?}"
    );
    let hers = drain(&mut saelyn);
    assert!(
        !hers
            .iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "m")),
        "Saelyn can still see it, got {hers:?}"
    );

    // And back: Torrin is handed it again.
    state.handle(
        ClientId(1),
        ClientMsg::SetVision {
            vision: Vision::Party,
        },
    );
    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.id.0 == "m")),
        "under party sight again, got {his:?}"
    );
}

#[test]
fn a_player_cannot_anchor_a_drawing_to_a_monster_only_their_friend_can_see() {
    // The oracle guard in `check` asks the sender's own sight, so Torrin's
    // refusal is the same as for an id that doesn't exist.
    let mut state = two_scouts(Vision::Split);
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    state.handle(
        ClientId(3),
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Token(TokenId::new("m")),
            to: Pos { x: 2.0, y: 0.0 },
            color: "#ff0000".to_owned(),
            points: Vec::new(),
        },
    );
    let frames = drain(&mut torrin);
    assert!(
        frames.iter().any(
            |msg| matches!(msg, ServerMsg::Error { message } if message == "no such token: m")
        ),
        "got {frames:?}"
    );
    assert!(state.shapes.is_empty());
}

#[test]
fn only_the_dm_may_split_the_partys_sight() {
    let mut state = two_scouts(Vision::Party);
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(
        ClientId(2),
        ClientMsg::SetVision {
            vision: Vision::Split,
        },
    );
    assert!(
        drain(&mut rx)
            .iter()
            .any(|msg| matches!(msg, ServerMsg::Error { .. }))
    );
    assert_eq!(state.vision, Vision::Party);
}

#[test]
fn under_split_sight_a_party_member_out_of_view_comes_and_goes_like_a_monster() {
    let mut state = two_scouts(Vision::Split);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut saelyn, &mut torrin]);

    let saelyn_moves_to = |state: &mut RoomState, y: f32| {
        state.handle(
            ClientId(2),
            ClientMsg::MoveToken {
                id: TokenId::new("p"),
                x: 1.5,
                y,
                dragging: false,
                staged: false,
            },
        );
    };

    // Two cells from Torrin: inside his thirty feet.
    saelyn_moves_to(&mut state, 10.5);
    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.id.0 == "p")),
        "Saelyn walks into Torrin's view, got {his:?}"
    );

    // And back up the corridor, out of it again.
    saelyn_moves_to(&mut state, 1.5);
    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "p")),
        "and leaves his board when she walks out of it, got {his:?}"
    );
    let hers = drain(&mut saelyn);
    assert!(
        !hers
            .iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "p")),
        "while her own token never leaves hers, got {hers:?}"
    );
}

#[test]
fn switching_to_split_sight_takes_a_distant_party_member_off_the_board() {
    let mut state = two_scouts(Vision::Party);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    assert!(names(&state.snapshot_for(&as_player("torrin"))).contains(&"Saelyn"));
    drain(&mut torrin);

    state.handle(
        ClientId(1),
        ClientMsg::SetVision {
            vision: Vision::Split,
        },
    );
    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "p")),
        "got {his:?}"
    );
}

#[test]
fn under_split_sight_a_friends_lantern_lights_for_whoever_can_see_them() {
    // Saelyn carries a lantern. Torrin is eleven cells off with thirty feet of
    // his own: he can't reach her, but nothing stands between them, so he sees
    // her and what her lantern lights, the ogre included. A brazier's rule.
    let mut state = two_scouts(Vision::Split);
    let _dm = join_as_dm(&mut state, ClientId(1));
    if let Some(p) = state.tokens.get_mut(&TokenId::new("p")) {
        p.light_ft = Some(30.0);
    }
    state.recompute_sight();
    let view = state.snapshot_for(&as_player("torrin"));
    let torrin = names(&view);
    assert!(torrin.contains(&"Saelyn"), "got {torrin:?}");
    assert!(torrin.contains(&"Ogre"), "got {torrin:?}");

    // A wall across the corridor between them, and the lantern is hers alone.
    state.handle(ClientId(1), wall(0.0, 448.0, 1024.0, 448.0, false));
    let view = state.snapshot_for(&as_player("torrin"));
    let torrin = names(&view);
    assert!(!torrin.contains(&"Saelyn"), "got {torrin:?}");
    assert!(!torrin.contains(&"Ogre"), "got {torrin:?}");
    assert!(
        names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Ogre"),
        "while Saelyn still sees by it"
    );
}

#[test]
fn under_split_sight_a_players_vision_is_theirs_alone() {
    // The difference from a lantern. A dark map, Saelyn sees sixty feet and
    // Torrin ten. She sees the ogre; he doesn't, and doesn't see her either,
    // because her eyes light nothing for anyone else.
    let mut state = two_scouts(Vision::Split);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.map.vision_ft = 10.0;
    if let Some(p) = state.tokens.get_mut(&TokenId::new("p")) {
        p.vision_ft = Some(60.0);
    }
    state.recompute_sight();

    assert!(names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Ogre"));
    let view = state.snapshot_for(&as_player("torrin"));
    let torrin = names(&view);
    assert!(!torrin.contains(&"Ogre"), "got {torrin:?}");
    assert!(!torrin.contains(&"Saelyn"), "got {torrin:?}");
    assert!(
        state.visible.contains(&OGRE_CELL),
        "while the DM's board, the party's union, still shows what she sees"
    );
}

#[test]
fn under_split_sight_a_friend_out_of_view_keeps_their_initiative_row() {
    let mut state = two_scouts(Vision::Split);
    for (token, value) in [("p", 15), ("m", 12), ("q", 9)] {
        state.initiative.entries.push(InitiativeEntry {
            token: TokenId::new(token),
            value,
            label: None,
        });
    }
    state.initiative.current = Some(TokenId::new("p"));

    let torrin = state.initiative_for(&as_player("torrin"));
    let rows: Vec<(&str, Option<&str>)> = torrin
        .entries
        .iter()
        .map(|e| {
            (
                e.token.0.as_str(),
                e.label.as_ref().map(|l| l.name.as_str()),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [("p", Some("Saelyn")), ("q", None)],
        "Saelyn's row stays under a label; the ogre's is withheld; his own needs none"
    );
    assert_eq!(
        current(&torrin),
        Some("p"),
        "and her turn is still her turn"
    );
    let saelyn = state.initiative_for(&as_player("saelyn"));
    let hers: Vec<(&str, Option<&str>)> = saelyn
        .entries
        .iter()
        .map(|e| {
            (
                e.token.0.as_str(),
                e.label.as_ref().map(|l| l.name.as_str()),
            )
        })
        .collect();
    assert!(
        hers.contains(&("q", Some("Torrin"))) && hers.contains(&("m", None)),
        "Saelyn sees the ogre, and Torrin's row is labelled for her the same way, got {hers:?}"
    );
    assert!(
        state
            .initiative_for(&Identity::Dm)
            .entries
            .iter()
            .all(|e| e.label.is_none()),
        "nor does the DM"
    );

    // Only line of sight is waived. A friend the DM hid leaves the panel.
    if let Some(p) = state.tokens.get_mut(&TokenId::new("p")) {
        p.hidden = true;
    }
    let torrin = state.initiative_for(&as_player("torrin"));
    assert_eq!(order(&torrin), ["q"]);
    assert_eq!(current(&torrin), None);
}

#[test]
fn the_dm_alone_is_sent_each_players_fog_and_only_under_split_sight() {
    let state = two_scouts(Vision::Split);
    let dm = state.snapshot_for(&Identity::Dm);
    for player in ["saelyn", "torrin"] {
        assert_eq!(
            dm.fog_by.get(&PlayerId::new(player)),
            state.snapshot_for(&as_player(player)).fog.as_ref(),
            "the DM's copy of {player}'s fog is the one {player} is sent"
        );
    }
    assert!(
        state.snapshot_for(&as_player("saelyn")).fog_by.is_empty(),
        "a player is never sent anyone else's"
    );
    assert!(
        two_scouts(Vision::Party)
            .snapshot_for(&Identity::Dm)
            .fog_by
            .is_empty(),
        "and under party sight there is only the one"
    );
}

#[test]
fn a_fog_frame_carries_each_players_fog_to_the_dm_and_nobody_else() {
    let mut state = two_scouts(Vision::Split);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);
    walk(&mut state, 2.5);

    let to_dm = drain(&mut dm);
    assert!(
        to_dm.iter().any(|msg| matches!(
            msg,
            ServerMsg::FogChanged { fog_by, .. } if fog_by.contains_key(&PlayerId::new("torrin"))
        )),
        "got {to_dm:?}"
    );
    let to_her = drain(&mut saelyn);
    assert!(
        to_her
            .iter()
            .all(|msg| !matches!(msg, ServerMsg::FogChanged { fog_by, .. } if !fog_by.is_empty())),
        "got {to_her:?}"
    );
}

/// `two_scouts` with the DM and both players connected and every queue empty.
fn two_scouts_joined(
    vision: Vision,
) -> (
    RoomState,
    mpsc::Receiver<ServerMsg>,
    mpsc::Receiver<ServerMsg>,
    mpsc::Receiver<ServerMsg>,
) {
    let mut state = two_scouts(vision);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut dm, &mut saelyn, &mut torrin]);
    (state, dm, saelyn, torrin)
}

#[test]
fn under_split_sight_deleting_a_monster_tells_only_whoever_could_see_it() {
    let (mut state, _dm, mut saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    state.handle(
        ClientId(1),
        ClientMsg::DeleteToken {
            id: TokenId::new("m"),
        },
    );
    let hers = drain(&mut saelyn);
    assert!(
        hers.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "m")),
        "got {hers:?}"
    );
    let his = drain(&mut torrin);
    assert!(
        !mentions_the_ogre(&his),
        "a removal would name an id Torrin never held, got {his:?}"
    );
}

#[test]
fn under_split_sight_renaming_a_monster_reaches_only_whoever_can_see_it() {
    let (mut state, _dm, mut saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    let mut ogre = token(&state, "m");
    ogre.name = "Ogre Chieftain".to_owned();
    state.handle(ClientId(1), edit(&ogre));

    let hers = drain(&mut saelyn);
    assert!(
        hers.iter().any(|msg| matches!(
            msg,
            ServerMsg::TokenChanged { token } if token.name == "Ogre Chieftain"
        )),
        "got {hers:?}"
    );
    let his = drain(&mut torrin);
    assert!(!mentions_the_ogre(&his), "got {his:?}");
}

/// A drop, from the DM, onto a settled cell.
fn drop_at(state: &mut RoomState, id: &str, x: f32, y: f32) {
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new(id),
            x,
            y,
            dragging: false,
            staged: false,
        },
    );
}

#[test]
fn under_split_sight_a_player_whose_view_did_not_change_is_sent_nothing() {
    // Both scouts see the ogre, which has a row and an aura. Torrin walks off
    // and loses it; Saelyn still sees it, so nothing about it is news to her,
    // and a frame would tell her that Torrin's view just changed.
    let mut state = two_scouts(Vision::Split);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    drop_at(&mut state, "q", 5.5, 5.5);
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("m"),
            value: 12,
        },
    );
    state.handle(
        ClientId(1),
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Token(TokenId::new("m")),
            to: Pos { x: 2.0, y: 0.0 },
            color: "#ff8c42e6".to_owned(),
            points: Vec::new(),
        },
    );
    assert_eq!(state.shapes.len(), 1, "the aura is on the board");
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut dm, &mut saelyn, &mut torrin]);

    drop_at(&mut state, "q", 5.5, 13.5);

    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "m")),
        "Torrin loses the ogre, got {his:?}"
    );
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::InitiativeChanged { .. }))
            && his
                .iter()
                .any(|msg| matches!(msg, ServerMsg::ShapesChanged { .. })),
        "and its row and aura with it, got {his:?}"
    );

    let hers = drain(&mut saelyn);
    assert!(
        !hers.iter().any(|msg| matches!(
            msg,
            ServerMsg::TokenChanged { .. }
                | ServerMsg::InitiativeChanged { .. }
                | ServerMsg::ShapesChanged { .. }
        )),
        "Saelyn's board is as it was, got {hers:?}"
    );

    assert!(
        drain(&mut dm)
            .iter()
            .any(|msg| matches!(msg, ServerMsg::InitiativeChanged { .. })),
        "the DM is still sent it, so player view repaints"
    );
}

#[test]
fn under_split_sight_a_friend_pacing_out_of_view_sends_no_fog() {
    // Torrin steps back and forth over ground already explored. His own frame
    // changes each time; `known` doesn't, so Saelyn's frame doesn't either.
    let mut state = two_scouts(Vision::Split);
    let _dm = join_as_dm(&mut state, ClientId(1));
    drop_at(&mut state, "q", 2.5, 13.5);
    drop_at(&mut state, "q", 1.5, 12.5);
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut saelyn, &mut torrin]);

    drop_at(&mut state, "q", 2.5, 13.5);

    assert!(
        drain(&mut torrin)
            .iter()
            .any(|msg| matches!(msg, ServerMsg::FogChanged { .. })),
        "Torrin's own sight moved with him"
    );
    let hers = drain(&mut saelyn);
    assert!(
        !hers
            .iter()
            .any(|msg| matches!(msg, ServerMsg::FogChanged { .. })),
        "Saelyn's frame is the one she holds, got {hers:?}"
    );
}

#[test]
fn under_split_sight_a_monsters_drag_frames_reach_only_whoever_can_see_it() {
    let (mut state, _dm, mut saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("m"),
            x: 4.7,
            y: 1.6,
            dragging: true,
            staged: false,
        },
    );
    let hers = drain(&mut saelyn);
    assert!(
        hers.iter().any(
            |msg| matches!(msg, ServerMsg::TokenMoved { id, dragging: true, .. } if id.0 == "m")
        ),
        "got {hers:?}"
    );
    let his = drain(&mut torrin);
    assert!(
        his.is_empty(),
        "thirty frames a second would trace it across his board, got {his:?}"
    );
}

#[test]
fn under_split_sight_each_player_is_sent_their_own_fog_frame() {
    let (mut state, _dm, mut saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    walk(&mut state, 2.5);

    let fog_in = |frames: Vec<ServerMsg>| {
        frames.into_iter().find_map(|msg| match msg {
            ServerMsg::FogChanged { fog, fog_by } => Some((fog, fog_by)),
            _ => None,
        })
    };
    let (hers, her_by) = fog_in(drain(&mut saelyn)).expect("Saelyn's frame");
    let (his, his_by) = fog_in(drain(&mut torrin)).expect("Torrin's frame");
    assert_eq!(hers, state.fog_for(&as_player("saelyn")));
    assert_eq!(his, state.fog_for(&as_player("torrin")));
    assert_ne!(hers, his, "the same step, two different pictures");
    assert_ne!(
        his,
        state.fog_for(&Identity::Dm),
        "and Torrin's is not the party's"
    );
    assert!(her_by.is_empty() && his_by.is_empty());
}

#[test]
fn under_split_sight_a_lit_square_is_lit_for_every_player() {
    // The DM's mask applies to each player's sight, not only the party's.
    let (mut state, _dm, _saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Lit)));
    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.id.0 == "m")),
        "got {his:?}"
    );

    // And a dark one is dark for the player whose own eyes reached it.
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Dark)));
    assert!(!names(&state.snapshot_for(&as_player("saelyn"))).contains(&"Ogre"));
    assert!(!names(&state.snapshot_for(&as_player("torrin"))).contains(&"Ogre"));
}

#[test]
fn undoing_the_switch_puts_every_player_back_on_party_sight() {
    let (mut state, _dm, _saelyn, mut torrin) = two_scouts_joined(Vision::Party);
    state.handle(
        ClientId(1),
        ClientMsg::SetVision {
            vision: Vision::Split,
        },
    );
    drain(&mut torrin);
    state.handle(ClientId(1), ClientMsg::Undo);

    assert_eq!(state.vision, Vision::Party);
    let his = drain(&mut torrin);
    let restored = his.iter().find_map(|msg| match msg {
        ServerMsg::Restored { state } => Some(state),
        _ => None,
    });
    let restored = restored.expect("a restore");
    assert_eq!(restored.vision, Vision::Party);
    assert!(
        names(restored).contains(&"Ogre"),
        "the restore is built by Torrin's sight as it is now"
    );
}

#[test]
fn split_sight_survives_a_restart_and_is_derived_again() {
    let state = two_scouts(Vision::Split);
    let rebooted = reboot(state.to_saved());
    assert_eq!(rebooted.vision, Vision::Split);
    assert!(
        rebooted.visible_by.contains_key(&PlayerId::new("torrin")),
        "each player's sight isn't on disk, and comes back from the boot recompute"
    );
}

#[test]
fn under_split_sight_a_promote_tells_each_player_their_own_news() {
    // The ogre is planned beside Torrin on the next map. Saelyn was watching it
    // and loses it; Torrin meets it for the first time.
    let (mut state, _dm, mut saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    state.handle(
        ClientId(1),
        staged(fogged(set_map("/next.png", 64.0, 0.0, 0.0), 30.0)),
    );
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("m"),
            x: 1.5,
            y: 10.5,
            dragging: false,
            staged: true,
        },
    );
    settle(&mut [&mut saelyn, &mut torrin]);

    state.handle(ClientId(1), ClientMsg::PromoteStaged);

    let hers = drain(&mut saelyn);
    assert!(
        hers.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenRemoved { id } if id.0 == "m")),
        "got {hers:?}"
    );
    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.id.0 == "m")),
        "got {his:?}"
    );
}

/// Gives the ogre a row in the turn order and an aura, from the DM.
fn ogre_in_the_fight(state: &mut RoomState) {
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("m"),
            value: 12,
        },
    );
    state.handle(
        ClientId(1),
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Token(TokenId::new("m")),
            to: Pos { x: 2.0, y: 0.0 },
            color: "#ff8c42e6".to_owned(),
            points: Vec::new(),
        },
    );
}

fn rebuilds_a_panel(frames: &[ServerMsg]) -> bool {
    frames.iter().any(|msg| {
        matches!(
            msg,
            ServerMsg::InitiativeChanged { .. } | ServerMsg::ShapesChanged { .. }
        )
    })
}

#[test]
fn under_split_sight_handing_a_monster_over_brings_its_row_and_aura() {
    // Saelyn sees the ogre and Torrin doesn't. Handing it to Torrin makes it
    // his own, so it is in his sight wherever it stands, and the row and aura
    // come with it. Nothing about Saelyn's board changed.
    let (mut state, _dm, mut saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    ogre_in_the_fight(&mut state);
    settle(&mut [&mut saelyn, &mut torrin]);

    let mut ogre = token(&state, "m");
    ogre.owner = Owner::Player(PlayerId::new("torrin"));
    state.handle(ClientId(1), edit(&ogre));

    let his = drain(&mut torrin);
    assert!(
        his.iter()
            .any(|msg| matches!(msg, ServerMsg::TokenChanged { token } if token.id.0 == "m")),
        "got {his:?}"
    );
    assert!(
        his.iter().any(|msg| matches!(
            msg,
            ServerMsg::InitiativeChanged { initiative }
                if initiative.entries.iter().any(|e| e.token.0 == "m")
        )),
        "the row comes with it, got {his:?}"
    );
    assert!(
        his.iter().any(|msg| matches!(
            msg,
            ServerMsg::ShapesChanged { shapes } if !shapes.is_empty()
        )),
        "and the aura, got {his:?}"
    );

    let hers = drain(&mut saelyn);
    assert!(
        !rebuilds_a_panel(&hers),
        "Saelyn held the ogre before and after, got {hers:?}"
    );
}

#[test]
fn renaming_a_monster_in_the_dark_sends_the_table_nothing() {
    // Party sight. The ogre has a row and an aura but stands out of reach, so
    // the table holds neither. A rebuild on the rename would tell them the DM
    // just touched something they can't see.
    let mut state = fog_room(10.0);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    ogre_in_the_fight(&mut state);
    assert!(!sees_the_ogre(&state), "the ogre is in the dark");
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    let mut ogre = token(&state, "m");
    ogre.name = "Ogre Chieftain".to_owned();
    state.handle(ClientId(1), edit(&ogre));

    let hers = drain(&mut saelyn);
    assert!(hers.is_empty(), "got {hers:?}");
}

#[test]
fn splitting_the_sight_of_a_party_standing_together_still_sends_the_dm_each_players_fog() {
    // Torrin stands on Saelyn's cell, and they are the whole roster, so each
    // player's own sight is the party's and no player's frame changes. The
    // DM's does: player view has nothing to draw until `fog_by` arrives.
    let mut state = fog_room(30.0);
    state.roster = roster_from(&[("saelyn", "Saelyn"), ("torrin", "Torrin")]);
    state.tokens.insert(
        TokenId::new("q"),
        Token {
            id: TokenId::new("q"),
            name: "Torrin".to_owned(),
            x: 1.5,
            y: 1.5,
            owner: Owner::Player(PlayerId::new("torrin")),
            ..Token::default()
        },
    );
    state.recompute_sight();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut dm, &mut saelyn, &mut torrin]);

    state.handle(
        ClientId(1),
        ClientMsg::SetVision {
            vision: Vision::Split,
        },
    );

    let to_dm = drain(&mut dm);
    assert!(
        to_dm.iter().any(|msg| matches!(
            msg,
            ServerMsg::FogChanged { fog_by, .. }
                if fog_by.contains_key(&PlayerId::new("saelyn"))
                    && fog_by.contains_key(&PlayerId::new("torrin"))
        )),
        "got {to_dm:?}"
    );
    for (who, rx) in [("saelyn", &mut saelyn), ("torrin", &mut torrin)] {
        let frames = drain(rx);
        assert!(
            !frames
                .iter()
                .any(|msg| matches!(msg, ServerMsg::FogChanged { .. })),
            "{who}'s board is as it was, got {frames:?}"
        );
    }
}

#[test]
fn under_split_sight_a_slot_added_to_the_roster_sees_what_the_dm_lit() {
    let (mut state, mut dm, mut saelyn, mut torrin) = two_scouts_joined(Vision::Split);
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Lit)));
    settle(&mut [&mut dm, &mut saelyn, &mut torrin]);

    let mut roster = state.roster.clone();
    roster.push(RosterEntry {
        id: PlayerId::new("brin"),
        name: "Brin".to_owned(),
    });
    state.handle(ClientId(1), ClientMsg::SetRoster { roster });

    assert!(
        names(&state.snapshot_for(&as_player("brin"))).contains(&"Ogre"),
        "a lit square is lit for a player with no token too"
    );
    let to_dm = drain(&mut dm);
    assert!(
        to_dm.iter().any(|msg| matches!(
            msg,
            ServerMsg::FogChanged { fog_by, .. } if fog_by.contains_key(&PlayerId::new("brin"))
        )),
        "player view has a frame for the new slot, got {to_dm:?}"
    );
    for (who, rx) in [("saelyn", &mut saelyn), ("torrin", &mut torrin)] {
        let frames = drain(rx);
        assert!(
            !frames.iter().any(|msg| matches!(
                msg,
                ServerMsg::FogChanged { .. } | ServerMsg::TokenChanged { .. }
            )),
            "{who}'s board is as it was, got {frames:?}"
        );
    }
}

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
    // show", indistinguishable from the client side — the trick `staged`
    // plays, and the reason turning fog off needs no second field.
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
    // The milestone in one test. The player moves; the *monster* is what the
    // frame that follows is about, and it is a whole token because they have
    // never held it.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), between(false));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");

    assert!(!sees_the_ogre(&state));
    drain(&mut rx);

    // Past the wall. Walls block sight and never movement — decided, not
    // deferred — so this is an ordinary drop that happens to cross one.
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
            .any(|msg| matches!(msg, ServerMsg::FogChanged { fog: Some(_) })),
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
    // The roadmap's rule: recompute on the drop. The raycast is cheap enough
    // at 30 Hz and shipping a packed bitset to six people that often is not.
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
    // The opposite of the walls, deliberately. The geometry is the secret;
    // the shadow it casts is the thing everybody is playing with, and the DM
    // needs it to see what the table can see.
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
    // Terrain gates on `revealed`, tokens gate on `visible`. The party walks
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
    // standing on — which is the only kind a sweep can be seen to remove.
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
    // A feature that hides something and leaves it named in a panel has not
    // hidden it. Milestone 11 learned that of `hidden`; it is just as true
    // of a monster the party can no longer see.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("m"),
            value: 14,
        },
    );
    assert_eq!(state.initiative_for(false).entries.len(), 1);

    state.handle(ClientId(1), between(false));
    assert_eq!(
        state.initiative_for(false).entries.len(),
        0,
        "the row goes with the creature"
    );
    assert_eq!(
        state.initiative_for(true).entries.len(),
        1,
        "and stays on the DM's panel"
    );
}

#[test]
fn an_aura_on_a_creature_in_the_dark_is_not_sent() {
    // The arm `shapes_for` grew in milestone 14 because `hidden` already
    // existed. It reaches its third reason here without another line.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Token(TokenId::new("m")),
            to: Pos { x: 4.0, y: 0.0 },
            color: "#ff8c42e6".to_owned(),
        },
    );
    assert_eq!(state.shapes_for(false).len(), 1);

    state.handle(ClientId(1), between(false));
    assert_eq!(
        state.shapes_for(false).len(),
        0,
        "an aura on a monster in the dark is that monster's position in colour"
    );
    assert_eq!(state.shapes_for(true).len(), 1);
}

#[test]
fn renaming_a_creature_in_the_dark_tells_the_table_nothing() {
    // The trap this milestone had to fix everywhere `was_unseen` is read: it
    // used to mean `Token::unseen`, so an edit to a monster the party cannot
    // see would have sent them a `TokenRemoved` naming an id they had never
    // held — which announces that the id exists.
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
    // By construction rather than by rule: a player's token is a vision
    // source, so the cell it stands in is lit by it. That is also how handing
    // a token to a player grants sight with no extra rule.
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
    // The roadmap's implicit wall: vision does not spill into the void off
    // the edge of the map, and nothing in the wall editor produces that
    // boundary because it is already on `MapInfo`.
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

    let restored = RoomState::restored(state.to_saved(), SECRET.to_owned());

    assert_eq!(restored.revealed, explored, "explored terrain is on disk");
    assert!(
        restored.visible.is_empty(),
        "and sight is not — it is derived on boot, from the tokens the same file holds"
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
    // `snapToCorner` puts masonry *between* cell centres, so the last cell a
    // ray reaches is the floor inside the room and the drawn wall is past it.
    // Fog stopping there shows the table floor, then nothing, and the room
    // reads as a hole rather than as a room.
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
    // The whole of what the fringe is allowed to do. Terrain gates on `known`
    // and creatures gate on `visible`; widening the first and not the second is
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

    let restored = RoomState::restored(state.to_saved(), SECRET.to_owned());

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
    // The question the roadmap left open, answered: `Dark` subtracts from
    // `visible`, so `in_sight` says no and the token leaves through the
    // machinery `hidden` already uses. A DM who blacks out a room and finds
    // the monster still on the table's board has not blacked out the room.
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
    // **The whole reason this is a mask rather than a write into `revealed`.**
    // A hide that merely cleared the set would evaporate the next time
    // somebody carried a light past, which is the one thing a manual override
    // must not do — and the failure would look like a bug in the raycast.
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
    // The other direction, and the half 16b had backwards: the torch really
    // did reach the cell, and the mask hides that rather than destroying it.
    // Subtracting from memory here is what made a `Dark` fill unliftable.
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
    // The mirror of the test above, and the bug that sent me looking: an
    // `Explored` paint was unioned into `revealed` on every pass, so the cells
    // outlived the paint that put them there and a fill was permanent. One
    // stray click through a gap in a traced wall could hand over the whole
    // dungeon with no way back short of reloading the map.
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
    // Terrain and creatures, which is the split the whole feature is built
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
    // `Explored` is a floor and not an assignment. Making it demote a lit cell
    // would be a fifth state — "the room but not the ambush in it" — and that
    // is what `hidden` is.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), paint(&[OGRE_CELL], Some(Override::Explored)));

    assert!(state.visible.contains(&OGRE_CELL));
    assert!(sees_the_ogre(&state));
}

#[test]
fn a_player_keeps_their_own_token_in_a_blacked_out_room() {
    // `in_sight` returns true early for anything a player owns, so `Dark`
    // stops short of deleting the party from their own screens. Deliberate:
    // a magical darkness they cannot see out of is still one they are in.
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
    // `OverridesChanged` reaches the DM alone, so the whole of the table's
    // news is the `FogChanged` beside it — and the board going dark under
    // them is the one frame they most need.
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
    // The walls' rule, arriving for the third time. What the DM decided is
    // theirs; the difference it made is what the table is sent, in the
    // `FogChanged` beside it.
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
    // The gate that keeps `FogChanged` honest. A DM blacking out a corner of
    // the map the party has never been near changes nothing the table holds,
    // and a frame saying so would say *when* the DM was working.
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

#[test]
fn moving_the_lattice_forgets_the_overrides_and_a_new_map_does_too() {
    // Cells, like the two sets they mask — so the squares moving underneath
    // them is enough, and this is where they part company with the walls they
    // are stored beside, which trace the art and survive a recalibration.
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

    let restored = RoomState::restored(state.to_saved(), SECRET.to_owned());

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
    // telling them apart — exactly as it is for a token's position and its plan.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));

    state.handle(ClientId(1), staged(paint(&[OGRE_CELL], Some(Override::Dark))));

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
    // The live board's paint is never the whole news — `refresh_fog` reports the
    // shadow it cast beside it. The staged board's *is* the whole news, and
    // correctly: no ray has ever been cast on a map the table has not been shown.
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
        !frames.iter().any(|m| matches!(m, ServerMsg::FogChanged { .. })),
        "and nothing claims the table's view moved: {frames:?}"
    );
}

#[test]
fn the_staged_fog_switch_is_what_a_staged_paint_is_checked_against() {
    // The whole of what staging changed in this refusal: a fogged staged map
    // may be painted while the unfogged live board under it may not, which is
    // the DM preparing a dungeon from inside a meadow.
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
    state.handle(ClientId(1), staged(paint(&[OGRE_CELL], Some(Override::Dark))));
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
    // The live board's rule, mirrored — which is the argument for the two slots
    // holding the same three things. A wall is image pixels and still traces the
    // same painted line; an override is a cell whose square has just moved.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));
    state.handle(ClientId(1), staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)));
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
    // `clear_staged_tokens`' rule, reaching the other two things the slot now
    // holds. A different map is a different next room, and none of the tracing
    // done for the last one means anything on it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage_fogged(&mut state, ClientId(1));
    state.handle(ClientId(1), staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)));
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
    state.handle(ClientId(1), staged(trace(&[(0.0, 0.0), (64.0, 0.0)], false)));
    state.handle(ClientId(1), staged(paint(&[(1, 1)], Some(Override::Dark))));

    state.handle(ClientId(1), ClientMsg::ClearStaged);

    assert!(state.staged.is_none());
    assert!(state.walls.is_empty(), "and none of it fell onto the board");
    assert!(state.overrides.is_empty());
}

#[test]
fn a_player_is_never_sent_the_staged_boards_paint() {
    // The override travels like the walls rather than like the fog, and staging
    // did not change that — it is what the DM authored, on a map the table has
    // not been shown, which is the same rule twice over.
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

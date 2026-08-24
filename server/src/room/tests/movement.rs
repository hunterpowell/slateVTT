//! Dragging a token, and how the room stores what it never computes with.
//! See *Distance* in `docs/drawings.md` for the ruler the switch feeds.

use super::*;

// --- movement (unchanged from milestone 2) ------------------------------

#[test]
fn drop_frames_snap_and_drag_frames_do_not() {
    let mut state = room();

    let events = state.apply(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: 6.83,
            y: 5.21,
            dragging: true,
            staged: false,
        },
    );
    assert!(
        matches!(events.as_slice(), [Event::TokenMoved { x, y, .. }] if *x == 6.83 && *y == 5.21)
    );

    let events = state.apply(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: 6.83,
            y: 5.21,
            dragging: false,
            staged: false,
        },
    );
    assert!(
        matches!(events.as_slice(), [Event::TokenMoved { x, y, .. }] if *x == 6.5 && *y == 5.5)
    );

    let token = state.tokens.get(&TokenId::new("t1")).expect("t1 exists");
    assert_eq!((token.x, token.y), (6.5, 5.5));
}

#[test]
fn snapping_is_stable_under_repeated_drops() {
    for size in TOKEN_SIZES {
        let settled = snap_to_cell(6.4, 5.4, size);
        assert_eq!(
            snap_to_cell(settled.0, settled.1, size),
            settled,
            "a {size}-cell token drifted when dropped where it already was"
        );
    }
}

#[test]
fn snapping_handles_negative_coordinates() {
    // A token dragged off the top-left belongs in cell -1, not folded back
    // onto the board. Off-map drags are legal — that is where the DM stages
    // the next wave.
    assert_eq!(snap_to_cell(-0.2, -1.7, 1.0), (-0.5, -1.5));
    assert_eq!(snap_to_cell(-0.2, -1.7, 2.0), (0.0, -2.0));
}

#[test]
fn an_odd_token_settles_on_a_cell_centre_and_an_even_one_on_a_corner() {
    // The whole size-dependent snapping rule, stated once. A 2×2 covering
    // cells (0,0) through (1,1) is centred at (1,1) — the corner those four
    // cells meet at — because it has no middle cell to sit in.
    assert_eq!(snap_to_cell(6.83, 5.21, 1.0), (6.5, 5.5));
    assert_eq!(snap_to_cell(6.83, 5.21, 3.0), (6.5, 5.5));
    assert_eq!(snap_to_cell(6.83, 5.21, 2.0), (7.0, 5.0));
    assert_eq!(snap_to_cell(6.83, 5.21, 4.0), (7.0, 5.0));
}

#[test]
fn shrinking_off_a_corner_picks_one_cell_and_always_the_same_one() {
    // A 2×2 stands on the corner four cells meet at, so shrinking it is a
    // four-way tie. `round` breaks it away from zero — down and right on
    // the board, the other way in the negative space off the top-left of
    // it. Which cell it picks matters far less than picking the same one
    // every time, which is what stops a resize from looking like a jitter.
    assert_eq!(snap_to_cell(9.0, 4.0, 1.0), (9.5, 4.5));
    assert_eq!(snap_to_cell(-9.0, -4.0, 1.0), (-9.5, -4.5));
}

#[test]
fn a_tiny_token_settles_in_the_middle_of_a_square() {
    // Not on a quarter-cell lattice of its own. A druid who is a rat stands
    // in a square with everyone else, just drawn small.
    assert_eq!(snap_to_cell(6.83, 5.21, 0.5), (6.5, 5.5));
}

#[test]
fn originator_is_spared_drag_echoes_but_not_the_drop() {
    let state = room();
    let me = ClientId(1);
    let them = ClientId(2);

    let drag = Event::TokenMoved {
        id: TokenId::new("t1"),
        x: 1.0,
        y: 1.0,
        dragging: true,
        staged: false,
    };
    assert!(state.message_for(me, me, &drag).is_none());
    assert!(state.message_for(them, me, &drag).is_some());

    let drop = Event::TokenMoved {
        id: TokenId::new("t1"),
        x: 1.5,
        y: 1.5,
        dragging: false,
        staged: false,
    };
    assert!(state.message_for(me, me, &drop).is_some());
    assert!(state.message_for(them, me, &drop).is_some());
}

#[test]
fn unknown_tokens_are_refused() {
    let mut state = room();
    let _rx = join_as_dm(&mut state, ClientId(1));
    let msg = ClientMsg::MoveToken {
        id: TokenId::new("nope"),
        x: 0.0,
        y: 0.0,
        dragging: false,
        staged: false,
    };
    assert!(state.check(ClientId(1), &msg).is_err());
}

// --- how diagonals count -------------------------------------------------

#[test]
fn only_the_dm_can_change_how_diagonals_count() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    state.handle(
        ClientId(1),
        ClientMsg::SetDiagonals {
            diagonals: Diagonals::Alternating,
        },
    );

    assert_eq!(
        state.diagonals,
        Diagonals::Equal,
        "a player changed the counting convention for the whole table"
    );
}

#[test]
fn the_convention_reaches_the_table_and_the_dm_alike() {
    // `NamesChanged`'s test written again, and deliberately: this is the
    // second thing the DM alone may set that everybody is told, and the
    // failure it guards against is a player's ruler reading a different
    // number off the same move than the DM's.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(
        ClientId(1),
        ClientMsg::SetDiagonals {
            diagonals: Diagonals::Alternating,
        },
    );

    assert!(
        matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::DiagonalsChanged {
                diagonals: Diagonals::Alternating
            }]
        ),
        "the DM was not told their own switch landed"
    );
    assert!(
        matches!(
            drain(&mut saelyn).as_slice(),
            [ServerMsg::DiagonalsChanged {
                diagonals: Diagonals::Alternating
            }]
        ),
        "the table was not told how to count"
    );
}

#[test]
fn the_convention_is_in_every_snapshot_and_survives_the_save_file() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetDiagonals {
            diagonals: Diagonals::Alternating,
        },
    );

    assert_eq!(
        state.snapshot_for(&Identity::Dm).diagonals,
        Diagonals::Alternating
    );
    assert_eq!(
        state.snapshot_for(&as_player("saelyn")).diagonals,
        Diagonals::Alternating
    );

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = reboot(saved);

    assert_eq!(
        restored.diagonals,
        Diagonals::Alternating,
        "a switch the DM flipped once should be found flipped next week"
    );
}

#[test]
fn a_save_written_before_the_field_existed_counts_the_old_way() {
    // Invariant 2, and the one case where getting the default wrong would be
    // silent: an old room would still load, still play, and quietly report a
    // different distance than it did last week. `show_names` needed a custom
    // default to avoid this; `Equal` being the first variant is what saves
    // this one from needing one.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    let mut json = serde_json::to_value(state.to_saved()).expect("encodes");
    json.as_object_mut()
        .expect("a saved room is an object")
        .remove("diagonals")
        .expect("the field is there to remove");

    let saved: Saved = serde_json::from_value(json).expect("decodes without it");
    let restored = reboot(saved);

    assert_eq!(
        restored.diagonals,
        Diagonals::Equal,
        "a room saved before the switch existed changed how it counts"
    );
}

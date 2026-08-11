//! Joining, who may do what, and claiming a roster slot.

use super::*;

// --- handshake ----------------------------------------------------------

#[test]
fn an_anonymous_connection_is_offered_the_roster_and_no_state() {
    let mut state = room();
    let mut rx = connect(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: None,
        },
    );

    match rx.try_recv().expect("a reply") {
        ServerMsg::ChooseIdentity { roster } => assert_eq!(roster.len(), ROSTER.len()),
        other => panic!("expected ChooseIdentity, got {other:?}"),
    }
    assert!(
        state.clients.is_empty(),
        "must not be admitted without an identity"
    );
}

#[test]
fn the_correct_dm_secret_admits_a_dm() {
    let mut state = room();
    let mut rx = connect(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: Some(SECRET.to_owned()),
            player_id: None,
        },
    );

    match rx.try_recv().expect("a reply") {
        ServerMsg::Welcome {
            is_dm, player_id, ..
        } => {
            assert!(is_dm);
            assert_eq!(player_id, None, "a DM holds no roster slot");
        }
        other => panic!("expected Welcome, got {other:?}"),
    }
}

#[test]
fn a_wrong_dm_secret_falls_back_to_the_picker_without_admitting_anyone() {
    let mut state = room();
    let mut rx = connect(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: Some("guess".to_owned()),
            player_id: None,
        },
    );

    assert!(matches!(rx.try_recv(), Ok(ServerMsg::Error { .. })));
    assert!(matches!(
        rx.try_recv(),
        Ok(ServerMsg::ChooseIdentity { .. })
    ));
    assert!(state.clients.is_empty());
    assert!(
        state.pending.contains_key(&ClientId(1)),
        "still connected, still anonymous"
    );
}

#[test]
fn a_player_id_outside_the_roster_is_not_an_identity() {
    let mut state = room();
    let mut rx = connect(&mut state, ClientId(1));

    // Stale localStorage from a roster that has since changed.
    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new("ghost")),
        },
    );

    assert!(matches!(
        rx.try_recv(),
        Ok(ServerMsg::ChooseIdentity { .. })
    ));
    assert!(state.clients.is_empty());
}

#[test]
fn rejoining_the_same_slot_recovers_the_same_tokens() {
    let mut state = room();
    // A refresh is a new connection claiming the same slot; ownership is by
    // slot, so nothing is orphaned.
    let _first = join_as_player(&mut state, ClientId(1), "saelyn");
    state.clients.remove(&ClientId(1)); // the old socket closes
    let _second = join_as_player(&mut state, ClientId(2), "saelyn");

    let client = state.clients.get(&ClientId(2)).expect("rejoined");
    let saelyn_token = state.tokens.get(&TokenId::new("t2")).expect("t2");
    assert!(can_move(client, saelyn_token));
}

// --- permissions --------------------------------------------------------

#[test]
fn a_player_may_move_only_their_own_token() {
    let mut state = room();
    let _rx = join_as_player(&mut state, ClientId(1), "saelyn");
    let client = state.clients.get(&ClientId(1)).expect("joined");

    let own = state
        .tokens
        .get(&TokenId::new("t2"))
        .expect("Saelyn's token");
    let other_player = state
        .tokens
        .get(&TokenId::new("t1"))
        .expect("Cleodara's token");
    let monster = state
        .tokens
        .get(&TokenId::new("t6"))
        .expect("the DM's ogre");

    assert!(can_move(client, own));
    assert!(!can_move(client, other_player));
    assert!(!can_move(client, monster));
}

#[test]
fn the_dm_may_move_everything() {
    let mut state = room();
    let _rx = join_as_dm(&mut state, ClientId(1));
    let client = state.clients.get(&ClientId(1)).expect("joined");

    for token in state.tokens.values() {
        assert!(can_move(client, token), "DM blocked from {}", token.name);
    }
}

#[test]
fn moving_someone_elses_token_is_refused_by_name() {
    let mut state = room();
    let _rx = join_as_player(&mut state, ClientId(1), "saelyn");

    let err = state
        .check(
            ClientId(1),
            &ClientMsg::MoveToken {
                id: TokenId::new("t1"),
                x: 0.0,
                y: 0.0,
                dragging: false,
                staged: false,
            },
        )
        .expect_err("should be refused");
    assert!(
        err.contains("Cleodara"),
        "error should name the token: {err}"
    );
}

#[test]
fn an_unidentified_client_cannot_move_anything() {
    let mut state = room();
    let _rx = connect(&mut state, ClientId(1));

    assert!(
        state
            .check(
                ClientId(1),
                &ClientMsg::MoveToken {
                    id: TokenId::new("t1"),
                    x: 0.0,
                    y: 0.0,
                    dragging: false,
                    staged: false,
                }
            )
            .is_err()
    );
}

#[test]
fn a_refused_move_changes_nothing_and_tells_nobody() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    let mut cleodara = join_as_player(&mut state, ClientId(2), "cleodara");

    let before = state.tokens.get(&TokenId::new("t1")).expect("t1").x;
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: 99.0,
            y: 99.0,
            dragging: false,
            staged: false,
        },
    );

    assert_eq!(state.tokens.get(&TokenId::new("t1")).expect("t1").x, before);
    assert!(
        cleodara.try_recv().is_err(),
        "a refusal must not be broadcast"
    );
}

#[test]
fn identity_cannot_be_changed_after_joining() {
    let mut state = room();
    let mut rx = join_as_player(&mut state, ClientId(1), "saelyn");

    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: Some(SECRET.to_owned()),
            player_id: None,
        },
    );

    assert!(matches!(rx.try_recv(), Ok(ServerMsg::Error { .. })));
    let client = state.clients.get(&ClientId(1)).expect("still joined");
    assert_eq!(client.identity, Identity::Player(PlayerId::new("saelyn")));
}

// --- roster claims ------------------------------------------------------

#[test]
fn occupied_slots_are_reported_as_claimed() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    let slots = state.roster_slots();
    let claimed: Vec<_> = slots
        .iter()
        .filter(|s| s.claimed)
        .map(|s| s.id.0.as_str())
        .collect();
    assert_eq!(claimed, ["saelyn"]);
    assert_eq!(
        slots.len(),
        ROSTER.len(),
        "every slot is still offered — claiming is advisory"
    );
}

#[test]
fn a_slot_frees_up_when_its_client_disconnects() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    state.clients.remove(&ClientId(1));

    assert!(state.roster_slots().iter().all(|s| !s.claimed));
}

#[test]
fn the_dm_occupies_no_slot() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    assert!(state.roster_slots().iter().all(|s| !s.claimed));
}

#[test]
fn anyone_still_picking_is_told_when_a_slot_is_taken() {
    let mut state = room();
    let mut watcher = connect(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: None,
        },
    );
    watcher.try_recv().expect("the initial roster");

    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    match watcher.try_recv().expect("an updated roster") {
        ServerMsg::ChooseIdentity { roster } => {
            let saelyn = roster.iter().find(|s| s.id.0 == "saelyn").expect("saelyn");
            assert!(saelyn.claimed, "the open picker should have been refreshed");
        }
        other => panic!("expected ChooseIdentity, got {other:?}"),
    }
}

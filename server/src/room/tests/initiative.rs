//! Turn order, the round counter, and what a deleted token takes with it.
//! See *Initiative* in `docs/tokens.md`.

use super::*;

/// Builds an order without starting combat, as the DM typing values would.
fn rolled(pairs: &[(&str, i32)]) -> Initiative {
    let mut init = Initiative::default();
    for (token, value) in pairs {
        init.set(TokenId::new(token), *value);
    }
    init
}

/// Builds an order and starts combat, leaving the top entry acting.
fn in_combat(pairs: &[(&str, i32)]) -> Initiative {
    let mut init = rolled(pairs);
    init.next_turn();
    init
}

// --- initiative ---------------------------------------------------------

#[test]
fn entries_sort_by_value_descending() {
    let init = rolled(&[("t1", 12), ("t2", 20), ("t3", 7)]);
    assert_eq!(order(&init), ["t2", "t1", "t3"]);
}

#[test]
fn ties_keep_the_order_the_dm_entered_them() {
    let init = rolled(&[("t1", 14), ("t2", 14), ("t3", 14)]);
    assert_eq!(order(&init), ["t1", "t2", "t3"]);
}

#[test]
fn building_the_order_does_not_start_combat() {
    // The DM types values in the order the table calls them out, so the
    // first one entered says nothing about who acts first.
    let init = rolled(&[("t1", 12), ("t2", 19), ("t3", 12)]);
    assert_eq!(order(&init), ["t2", "t1", "t3"]);
    assert_eq!(
        current(&init),
        None,
        "nobody acts until the DM starts combat"
    );
}

#[test]
fn combat_starts_at_the_top_of_the_order_whatever_order_it_was_typed_in() {
    let mut init = rolled(&[("t1", 12), ("t2", 19), ("t3", 12)]);
    init.next_turn();
    assert_eq!(current(&init), Some("t2"), "highest roll acts first");
    assert_eq!(init.round, 1, "starting combat is not an extra round");
}

#[test]
fn a_latecomer_never_steals_the_turn() {
    let mut init = in_combat(&[("t1", 20)]);
    assert_eq!(current(&init), Some("t1"));

    // Someone joining mid-fight sorts above the acting creature but must
    // not seize the turn from it.
    init.set(TokenId::new("t2"), 25);
    assert_eq!(order(&init), ["t2", "t1"]);
    assert_eq!(current(&init), Some("t1"));
}

#[test]
fn re_valuing_an_entry_resorts_without_moving_the_turn() {
    let mut init = in_combat(&[("t1", 20), ("t2", 15), ("t3", 10)]);
    init.next_turn();
    assert_eq!(current(&init), Some("t2"));

    // The whole reason the current turn is tracked by token and not by list
    // index: this re-sort shifts t2 from position 1 to position 2.
    init.set(TokenId::new("t3"), 25);
    assert_eq!(order(&init), ["t3", "t1", "t2"]);
    assert_eq!(
        current(&init),
        Some("t2"),
        "the turn must not follow the index"
    );
}

#[test]
fn setting_an_existing_token_revalues_rather_than_duplicating() {
    let mut init = rolled(&[("t1", 20), ("t2", 15)]);
    init.set(TokenId::new("t2"), 30);
    assert_eq!(init.entries.len(), 2);
    assert_eq!(order(&init), ["t2", "t1"]);
}

#[test]
fn turns_advance_and_wrap_into_the_next_round() {
    let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
    assert_eq!((current(&init), init.round), (Some("t1"), 1));

    init.next_turn();
    assert_eq!((current(&init), init.round), (Some("t2"), 1));

    init.next_turn();
    assert_eq!(
        (current(&init), init.round),
        (Some("t1"), 2),
        "wrapping starts a new round"
    );
}

#[test]
fn turns_reverse_and_wrap_back_a_round() {
    let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
    init.next_turn();
    init.next_turn();
    assert_eq!((current(&init), init.round), (Some("t1"), 2));

    init.previous_turn();
    assert_eq!((current(&init), init.round), (Some("t2"), 1));
}

#[test]
fn reversing_past_the_start_of_combat_does_nothing() {
    let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
    init.previous_turn();
    assert_eq!(
        (current(&init), init.round),
        (Some("t1"), 1),
        "there is no round 0"
    );
}

#[test]
fn reversing_before_combat_starts_does_nothing() {
    let mut init = rolled(&[("t1", 20), ("t2", 15)]);
    init.previous_turn();
    assert_eq!((current(&init), init.round), (None, 1));
}

#[test]
fn removing_the_active_entry_hands_the_turn_to_the_next() {
    let mut init = in_combat(&[("t1", 20), ("t2", 15), ("t3", 10)]);
    init.next_turn();
    assert_eq!(current(&init), Some("t2"));

    init.remove(&TokenId::new("t2"));
    assert_eq!(order(&init), ["t1", "t3"]);
    assert_eq!(current(&init), Some("t3"));
}

#[test]
fn removing_an_inactive_entry_leaves_the_turn_alone() {
    let mut init = in_combat(&[("t1", 20), ("t2", 15), ("t3", 10)]);
    init.next_turn();
    init.remove(&TokenId::new("t3"));
    assert_eq!(current(&init), Some("t2"));
}

#[test]
fn emptying_the_list_leaves_nobody_acting() {
    let mut init = in_combat(&[("t1", 20)]);
    init.remove(&TokenId::new("t1"));
    assert!(init.entries.is_empty());
    assert_eq!(current(&init), None);
}

#[test]
fn advancing_an_empty_list_is_a_no_op() {
    let mut init = Initiative::default();
    init.next_turn();
    init.previous_turn();
    assert_eq!((current(&init), init.round), (None, 1));
}

#[test]
fn clearing_resets_the_round_counter() {
    let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
    init.next_turn();
    init.next_turn();
    assert_eq!(init.round, 2);

    init.clear();
    assert_eq!(
        (current(&init), init.round, init.entries.len()),
        (None, 1, 0)
    );
}

#[test]
fn only_the_dm_may_touch_initiative() {
    let mut state = room();
    let _player = join_as_player(&mut state, ClientId(1), "saelyn");
    let _dm = join_as_dm(&mut state, ClientId(2));

    let commands = || {
        vec![
            ClientMsg::SetInitiative {
                token: TokenId::new("t1"),
                value: 15,
            },
            ClientMsg::RemoveFromInitiative {
                token: TokenId::new("t1"),
            },
            ClientMsg::ClearInitiative,
            ClientMsg::NextTurn,
            ClientMsg::PreviousTurn,
        ]
    };

    for cmd in commands() {
        assert!(
            state.check(ClientId(1), &cmd).is_err(),
            "a player got through: {cmd:?}"
        );
    }
    for cmd in commands() {
        assert!(
            state.check(ClientId(2), &cmd).is_ok(),
            "the DM was blocked: {cmd:?}"
        );
    }
}

#[test]
fn initiative_cannot_name_a_token_that_does_not_exist() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let cmd = ClientMsg::SetInitiative {
        token: TokenId::new("ghost"),
        value: 10,
    };
    assert!(state.check(ClientId(1), &cmd).is_err());
}

#[test]
fn a_players_refused_initiative_edit_changes_nothing() {
    let mut state = room();
    let _player = join_as_player(&mut state, ClientId(1), "saelyn");
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("t1"),
            value: 99,
        },
    );
    assert!(state.initiative.entries.is_empty());
}

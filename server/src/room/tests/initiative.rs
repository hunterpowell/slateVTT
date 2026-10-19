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

    // Why the current turn is tracked by token and not by list index: this
    // re-sort shifts t2 from position 1 to position 2.
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

// --- a player's own roll ------------------------------------------------------

fn set(token: &str, value: i32) -> ClientMsg {
    ClientMsg::SetInitiative {
        token: TokenId::new(token),
        value,
    }
}

#[test]
fn a_player_enters_their_own_roll_once_and_the_dm_corrects_it() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    let _dm = join_as_dm(&mut state, ClientId(2));

    // t2 is Saelyn's.
    state.handle(ClientId(1), set("t2", 14));
    assert_eq!(order(&state.initiative), ["t2"]);

    // A second entry is a correction, and correcting is the DM's.
    assert!(state.check(ClientId(1), &set("t2", 20)).is_err());
    state.handle(ClientId(1), set("t2", 20));
    assert_eq!(state.initiative.entries[0].value, 14);

    state.handle(ClientId(2), set("t2", 20));
    assert_eq!(state.initiative.entries[0].value, 20);
}

#[test]
fn a_player_may_enter_a_roll_after_combat_has_started() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    let _dm = join_as_dm(&mut state, ClientId(2));
    state.handle(ClientId(2), set("t6", 12));
    state.handle(ClientId(2), ClientMsg::NextTurn);

    state.handle(ClientId(1), set("t2", 18));
    assert_eq!(order(&state.initiative), ["t2", "t6"]);
    assert_eq!(current(&state.initiative), Some("t6"), "a latecomer waits");
}

#[test]
fn a_player_may_not_enter_a_roll_for_a_token_they_do_not_own() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    // Another player's (Cleodara's) and the DM's (the ogre).
    for token in ["t1", "t6"] {
        assert!(
            state.check(ClientId(1), &set(token, 10)).is_err(),
            "Saelyn entered a roll for {token}"
        );
        state.handle(ClientId(1), set(token, 10));
    }
    assert!(state.initiative.entries.is_empty());
}

#[test]
fn a_player_is_told_nothing_about_a_token_the_table_cannot_see() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), create_hidden("Lurker"));
    let lurker = made(&state, "Lurker").id;
    // Saelyn's own token, hidden by the DM: it isn't on her board either.
    state.handle(ClientId(1), set_hidden(&token(&state, "t2"), true));
    settle(&mut [&mut dm, &mut saelyn]);

    let ghost = state.check(ClientId(2), &set("ghost", 10));
    let hidden = state.check(ClientId(2), &set(&lurker.0, 10));
    let own_hidden = state.check(ClientId(2), &set("t2", 10));
    assert!(ghost.is_err());
    assert_eq!(
        hidden, ghost,
        "the refusal told a player a hidden token exists"
    );
    assert_eq!(own_hidden, ghost);
}

#[test]
fn a_player_may_not_enter_a_roll_for_their_token_on_the_next_map() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    stage(&mut state, ClientId(1), "/maps/crypt.png");
    let saelyn = Owner::Player(PlayerId::new("saelyn"));
    state.handle(
        ClientId(1),
        with(create("Familiar", 1.0, saelyn), |_, staged| *staged = true),
    );
    let familiar = made(&state, "Familiar");
    assert!(familiar.staged_only);

    state.handle(ClientId(2), set(&familiar.id.0, 10));
    assert!(state.initiative.entries.is_empty());
}

#[test]
fn removing_every_row_one_at_a_time_starts_the_next_fight_on_round_one() {
    // The one-shot's bug: Clear is hidden while the panel is folded, so the DM
    // ended the fight row by row and the next one began on round 3.
    let mut init = in_combat(&[("t1", 20), ("t2", 15)]);
    init.next_turn();
    init.next_turn();
    init.next_turn();
    assert_eq!(init.round, 2);

    init.remove(&TokenId::new("t1"));
    init.remove(&TokenId::new("t2"));
    assert_eq!((current(&init), init.round), (None, 1));

    init.set(TokenId::new("t3"), 12);
    init.next_turn();
    assert_eq!((current(&init), init.round), (Some("t3"), 1));
}

// --- rolling the monsters ---------------------------------------------------

/// The rolled lines one connection was sent, in order.
fn rolled_lines(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<ChatLine> {
    drain(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::Said { line } if line.rolled => Some(line),
            _ => None,
        })
        .collect()
}

#[test]
fn rolling_enters_every_dm_creature_on_the_board_that_has_not_rolled() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    stage(&mut state, ClientId(1), "/maps/next.png");
    state.handle(ClientId(1), create_hidden("Lurker"));
    state.handle(
        ClientId(1),
        with(create("Next Room", 1.0, Owner::Dm), |_, staged| {
            *staged = true
        }),
    );
    let lurker = made(&state, "Lurker").id;
    let next = made(&state, "Next Room").id;
    assert!(token(&state, next.0.as_str()).staged_only);

    // The ogre already rolled; the DM typed it. Its number must not change.
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("t6"),
            value: 30,
        },
    );
    state.handle(ClientId(1), ClientMsg::RollInitiative);

    let rows: HashMap<&str, i32> = state
        .initiative
        .entries
        .iter()
        .map(|e| (e.token.0.as_str(), e.value))
        .collect();
    assert_eq!(rows.get("t6"), Some(&30), "a creature that rolled kept it");
    for id in ["t7", lurker.0.as_str()] {
        let value = *rows.get(id).unwrap_or_else(|| panic!("{id} did not roll"));
        assert!((1..=20).contains(&value), "{id} rolled {value}");
    }
    assert!(!rows.contains_key(next.0.as_str()), "the next room rolled");
    assert!(
        !rows.contains_key("t1"),
        "a player's character was rolled for"
    );
    assert_eq!(rows.len(), 3);
    assert_eq!(
        current(&state.initiative),
        None,
        "rolling builds the order; it does not start the fight"
    );
}

#[test]
fn only_the_dm_may_roll_the_monsters() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    state.handle(ClientId(1), ClientMsg::RollInitiative);
    assert!(state.initiative.entries.is_empty());
    assert!(state.chat.is_empty());
    assert!(matches!(
        drain(&mut saelyn).as_slice(),
        [ServerMsg::Error { .. }]
    ));
}

#[test]
fn the_rolls_reach_the_dm_alone_and_a_hidden_monster_stays_hidden() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), create_hidden("Lurker"));
    let lurker = made(&state, "Lurker").id;
    settle(&mut [&mut dm, &mut saelyn]);

    state.handle(ClientId(1), ClientMsg::RollInitiative);

    let lines = rolled_lines(&mut dm);
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!((&line.by, &line.to), (&Owner::Dm, &ChatTo::Dm));
    assert!(line.text.starts_with("Initiative: "), "{}", line.text);
    assert!(line.text.contains("Lurker"), "{}", line.text);

    let frames = drain(&mut saelyn);
    assert!(
        !frames.iter().any(|m| matches!(m, ServerMsg::Said { .. })),
        "a player was sent the DM's rolls: {frames:?}"
    );
    let table = frames
        .iter()
        .find_map(|m| match m {
            ServerMsg::InitiativeChanged { initiative } => Some(initiative),
            _ => None,
        })
        .expect("the table's order changed too");
    assert!(order(table).contains(&"t6"));
    assert!(
        !order(table).contains(&lurker.0.as_str()),
        "the table was sent a row for a hidden monster"
    );

    // And a player joining afterwards gets neither in their snapshot.
    let mut late = connect(&mut state, ClientId(3));
    state.handle(
        ClientId(3),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new("torrin")),
        },
    );
    match late.try_recv() {
        Ok(ServerMsg::Welcome { state: view, .. }) => {
            assert!(view.chat.is_empty(), "the snapshot carried the rolls");
            assert!(!order(&view.initiative).contains(&lurker.0.as_str()));
        }
        other => panic!("expected a welcome, got {other:?}"),
    }
}

#[test]
fn rolling_is_one_step_on_the_ring() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), ClientMsg::RollInitiative);
    let label = drain_all(&mut dm).into_iter().find_map(|m| match m {
        ServerMsg::UndoChanged { label } => Some(label),
        _ => None,
    });
    assert_eq!(label.flatten().as_deref(), Some("rolling initiative"));

    state.handle(ClientId(1), ClientMsg::Undo);
    assert!(state.initiative.entries.is_empty(), "undo kept the rows");
    assert_eq!(state.chat.len(), 1, "undo took back a thrown die");
}

#[test]
fn nobody_left_to_roll_is_not_an_error_and_not_a_step() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), ClientMsg::RollInitiative);
    let depth = state.undo.len();
    drain_all(&mut dm);

    assert!(!state.handle(ClientId(1), ClientMsg::RollInitiative));
    assert_eq!(state.undo.len(), depth);
    assert_eq!(state.chat.len(), 1, "a second batch was logged");
    assert!(drain_all(&mut dm).is_empty());
}

#[test]
fn the_largest_batch_of_rolls_fits_in_chat_lines() {
    // The two-limits rule, as `the_largest_roll_fits_a_chat_line`: the worst
    // case is a room full of monsters with the longest names allowed, all
    // rolling double figures.
    let name = "W".repeat(MAX_TOKEN_NAME_LEN);
    let rolls = vec![(name.clone(), 20); MAX_TOKENS];
    let lines = initiative_lines(&rolls);

    for line in &lines {
        assert!(
            line.chars().count() <= MAX_CHAT_LEN,
            "{} characters against a cap of {MAX_CHAT_LEN}",
            line.chars().count()
        );
    }
    let named: usize = lines.iter().map(|l| l.matches(&name).count()).sum();
    assert_eq!(named, MAX_TOKENS, "a creature was left out of the log");
}

#[test]
fn a_room_full_of_monsters_rolls_in_lines_that_fit() {
    // The same through the room, with every line delivered.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    while state.tokens.len() < MAX_TOKENS {
        let n = state.tokens.len();
        state.handle(
            ClientId(1),
            create(
                &format!("{n:0>width$}", width = MAX_TOKEN_NAME_LEN),
                1.0,
                Owner::Dm,
            ),
        );
        // Drain as we go: a full mailbox stops `apply` silently.
        drain_all(&mut dm);
    }
    state.handle(ClientId(1), ClientMsg::RollInitiative);
    let lines = rolled_lines(&mut dm);
    assert!(lines.len() > 1, "the batch was never split");
    assert!(lines.iter().all(|l| l.text.chars().count() <= MAX_CHAT_LEN));
}

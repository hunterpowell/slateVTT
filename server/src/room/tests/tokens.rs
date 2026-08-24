//! The token lifecycle, the name switch, and the two DM-only fields.
//! See `docs/tokens.md`.

use super::*;

// --- the token lifecycle ------------------------------------------------

#[test]
fn the_dm_can_build_a_token_and_the_server_names_it() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let before = state.tokens.len();

    assert!(
        state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm)),
        "a new token is worth saving"
    );

    assert_eq!(state.tokens.len(), before + 1);
    let goblin = made(&state, "Goblin");
    assert!(
        !goblin.id.0.is_empty() && !state.tokens.contains_key(&TokenId::new("t1_")),
        "the id comes from the server, not the client"
    );
    assert_eq!((goblin.x, goblin.y), (6.5, 5.5), "it lands on the grid");
    assert_eq!(goblin.size, 1.0);
}

#[test]
fn two_tokens_built_the_same_way_are_still_two_tokens() {
    // The id is invented per command, so a DM clicking twice gets a pair
    // rather than overwriting the first.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm));
    state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm));

    let goblins = state.tokens.values().filter(|t| t.name == "Goblin").count();
    assert_eq!(goblins, 2);
}

#[test]
fn a_new_token_lands_on_the_lattice_its_size_belongs_to() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    // Not "Ogre": the built-in room already has one, and `made` matches by
    // name. Created at (6.3, 5.1) by `create`.
    state.handle(ClientId(1), create("Dire Wolf", 2.0, Owner::Dm));

    let wolf = made(&state, "Dire Wolf");
    assert_eq!(
        (wolf.x, wolf.y),
        (6.0, 5.0),
        "an even-sized token settles on a cell corner"
    );
}

#[test]
fn resizing_a_token_moves_it_onto_the_right_lattice() {
    // The reason `UpdateToken` re-snaps. Left where it stood, a 2×2 grown
    // from a 1×1 would straddle half a cell in both directions until the
    // next time somebody happened to drag it.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6").clone();
    assert_eq!((ogre.x, ogre.y), (14.5, 9.5));

    state.handle(
        ClientId(1),
        ClientMsg::UpdateToken {
            id: ogre.id.clone(),
            name: ogre.name.clone(),
            img: ogre.img.clone(),
            size: 2.0,
            owner: Owner::Dm,
            hidden: false,
            hp: None,
        },
    );

    let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6");
    assert_eq!((ogre.x, ogre.y), (15.0, 10.0));
}

#[test]
fn an_edit_that_leaves_the_size_alone_leaves_the_position_alone() {
    // Renaming a token mid-drag must not teleport it: `MoveToken` owns the
    // position, and an unsnapped drag frame is a legitimate state to be in.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("t6"),
            x: 3.27,
            y: 8.11,
            dragging: true,
            staged: false,
        },
    );

    state.handle(
        ClientId(1),
        ClientMsg::UpdateToken {
            id: TokenId::new("t6"),
            name: "Ogre (bloodied)".to_owned(),
            img: "/uploads/ogre.png".to_owned(),
            size: 1.0,
            owner: Owner::Dm,
            hidden: false,
            hp: None,
        },
    );

    let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6");
    assert_eq!((ogre.x, ogre.y), (3.27, 8.11));
    assert_eq!(ogre.name, "Ogre (bloodied)");
}

#[test]
fn handing_a_token_to_a_player_lets_them_move_it_and_taking_it_back_does_not() {
    // The wild shape story end to end: the DM builds a big cat, gives it to
    // Saelyn, and takes it back when the spell ends.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), create("Dire Wolf", 2.0, Owner::Dm));
    let wolf = made(&state, "Dire Wolf");

    let saelyn = state.clients.get(&ClientId(2)).expect("joined");
    assert!(!can_move(saelyn, &wolf), "it starts as the DM's");

    let hand_to = |owner: Owner| ClientMsg::UpdateToken {
        id: wolf.id.clone(),
        name: wolf.name.clone(),
        img: wolf.img.clone(),
        size: wolf.size,
        owner,
        hidden: false,
        hp: None,
    };

    state.handle(ClientId(1), hand_to(Owner::Player(PlayerId::new("saelyn"))));
    let saelyn = state.clients.get(&ClientId(2)).expect("joined");
    assert!(can_move(saelyn, &made(&state, "Dire Wolf")));

    state.handle(ClientId(1), hand_to(Owner::Dm));
    let saelyn = state.clients.get(&ClientId(2)).expect("joined");
    assert!(!can_move(saelyn, &made(&state, "Dire Wolf")));
}

#[test]
fn a_player_cannot_touch_the_lifecycle_at_all() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    let _dm = join_as_dm(&mut state, ClientId(2));

    // Including their own token: reassigning `owner` is how a token is given
    // away, so a player who could edit theirs could take anyone's.
    let commands = || {
        vec![
            create("Goblin", 1.0, Owner::Dm),
            ClientMsg::UpdateToken {
                id: TokenId::new("t2"),
                name: "Saelyn".to_owned(),
                img: String::new(),
                size: 4.0,
                owner: Owner::Player(PlayerId::new("saelyn")),
                hidden: false,
                hp: None,
            },
            ClientMsg::DeleteToken {
                id: TokenId::new("t1"),
            },
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
fn a_players_refused_edit_changes_nothing() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    state.handle(
        ClientId(1),
        ClientMsg::UpdateToken {
            id: TokenId::new("t6"),
            name: "Mine Now".to_owned(),
            img: String::new(),
            size: 4.0,
            owner: Owner::Player(PlayerId::new("saelyn")),
            hidden: false,
            hp: None,
        },
    );

    let ogre = state.tokens.get(&TokenId::new("t6")).expect("t6");
    assert_eq!(ogre.name, "Ogre");
    assert_eq!(ogre.owner, Owner::Dm);
    assert_eq!(ogre.size, 1.0);
}

#[test]
fn deleting_a_token_takes_its_initiative_row_with_it() {
    // Otherwise the order holds a row naming a token that no longer exists,
    // which the panel draws as a bare id and `next_turn` hands the turn to.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for (token, value) in [("t1", 20), ("t6", 15), ("t7", 10)] {
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new(token),
                value,
            },
        );
    }
    state.handle(ClientId(1), ClientMsg::NextTurn);
    state.handle(ClientId(1), ClientMsg::NextTurn);
    assert_eq!(current(&state.initiative), Some("t6"));

    state.handle(
        ClientId(1),
        ClientMsg::DeleteToken {
            id: TokenId::new("t6"),
        },
    );

    assert!(!state.tokens.contains_key(&TokenId::new("t6")));
    assert_eq!(order(&state.initiative), ["t1", "t7"]);
    assert_eq!(
        current(&state.initiative),
        Some("t7"),
        "the turn passes to whoever slid into that slot"
    );
}

#[test]
fn deleting_a_token_that_was_not_in_the_order_says_nothing_about_initiative() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("t1"),
            value: 20,
        },
    );

    let events = state.apply(
        ClientId(1),
        ClientMsg::DeleteToken {
            id: TokenId::new("t6"),
        },
    );

    assert!(
        matches!(events.as_slice(), [Event::TokenRemoved { .. }]),
        "an untouched initiative panel should not be rebuilt: {events:?}"
    );
}

#[test]
fn a_token_that_does_not_exist_cannot_be_edited_or_deleted() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    assert!(
        state
            .check(
                ClientId(1),
                &ClientMsg::DeleteToken {
                    id: TokenId::new("ghost")
                }
            )
            .is_err()
    );
    assert!(
        state
            .check(
                ClientId(1),
                &ClientMsg::UpdateToken {
                    id: TokenId::new("ghost"),
                    name: "Ghost".to_owned(),
                    img: String::new(),
                    size: 1.0,
                    owner: Owner::Dm,
                    hidden: false,
                    hp: None,
                }
            )
            .is_err()
    );
}

#[test]
fn only_the_five_sizes_are_accepted() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for size in TOKEN_SIZES {
        assert!(
            state
                .check(ClientId(1), &create("Goblin", size, Owner::Dm))
                .is_ok(),
            "{size} should be fine"
        );
    }
    for size in [0.0, -1.0, 0.25, 1.5, 5.0, 1e9, f32::NAN, f32::INFINITY] {
        assert!(
            state
                .check(ClientId(1), &create("Goblin", size, Owner::Dm))
                .is_err(),
            "{size} should be refused"
        );
    }
}

#[test]
fn a_token_needs_a_name_and_cannot_have_an_essay() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for bad in ["", "   ", "\t"] {
        assert!(
            state
                .check(ClientId(1), &create(bad, 1.0, Owner::Dm))
                .is_err(),
            "{bad:?} should be refused"
        );
    }
    assert!(
        state
            .check(
                ClientId(1),
                &create(&"a".repeat(MAX_TOKEN_NAME_LEN + 1), 1.0, Owner::Dm)
            )
            .is_err()
    );
}

#[test]
fn a_name_is_stored_trimmed() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), create("  Goblin  ", 1.0, Owner::Dm));
    assert_eq!(made(&state, "Goblin").name, "Goblin");
}

#[test]
fn token_art_has_to_live_on_this_server() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    let with_img = |img: &str| ClientMsg::CreateToken {
        name: "Goblin".to_owned(),
        img: img.to_owned(),
        size: 1.0,
        owner: Owner::Dm,
        x: 0.0,
        y: 0.0,
        hidden: false,
        hp: None,
        staged: false,
    };

    for good in ["", "/uploads/abc.png", "/assets/tokens/ogre.png"] {
        assert!(
            state.check(ClientId(1), &with_img(good)).is_ok(),
            "{good:?} should be fine"
        );
    }
    for bad in [
        "https://example.com/goblin.png",
        "//example.com/goblin.png", // protocol-relative, so still off-site
        "uploads/abc.png",
        "data:image/png;base64,AAAA",
    ] {
        assert!(
            state.check(ClientId(1), &with_img(bad)).is_err(),
            "{bad:?} should be refused"
        );
    }
}

#[test]
fn a_room_cannot_be_filled_with_tokens_without_limit() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    // `apply` rather than `handle`: the cap being tested lives in `check`,
    // and filling the room through the whole pipeline would only fill this
    // test's outbound mailbox and get the DM dropped as a wedged client.
    for _ in state.tokens.len()..MAX_TOKENS {
        state.apply(ClientId(1), create("Goblin", 1.0, Owner::Dm));
    }

    assert_eq!(state.tokens.len(), MAX_TOKENS);
    assert!(
        state
            .check(ClientId(1), &create("Goblin", 1.0, Owner::Dm))
            .is_err()
    );
}

#[test]
fn a_created_token_reaches_the_dm_who_made_it() {
    // There is no local prediction to rubber-band — the client cannot know
    // the id — so this echo is how the DM's panel learns what it just built.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    state.handle(ClientId(1), create("Goblin", 1.0, Owner::Dm));

    for (who, rx) in [("the DM", &mut dm), ("a player", &mut saelyn)] {
        match rx.try_recv() {
            Ok(ServerMsg::TokenChanged { token }) => assert_eq!(token.name, "Goblin"),
            other => panic!("{who} should have been told: {other:?}"),
        }
    }
}

#[test]
fn a_deleted_token_reaches_everyone() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    state.handle(
        ClientId(1),
        ClientMsg::DeleteToken {
            id: TokenId::new("t6"),
        },
    );

    for (who, rx) in [("the DM", &mut dm), ("a player", &mut saelyn)] {
        match rx.try_recv() {
            Ok(ServerMsg::TokenRemoved { id }) => assert_eq!(id, TokenId::new("t6")),
            other => panic!("{who} should have been told: {other:?}"),
        }
    }
}

#[test]
fn a_new_token_survives_the_save_file() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), create("Dire Wolf", 2.0, Owner::Dm));

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = reboot(saved);

    let wolf = made(&restored, "Dire Wolf");
    assert_eq!(wolf.size, 2.0);
    assert_eq!((wolf.x, wolf.y), (6.0, 5.0));
}

// --- names on the board -------------------------------------------------

#[test]
fn only_the_dm_can_label_the_board() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    state.handle(ClientId(1), ClientMsg::SetShowNames { show: false });

    assert!(
        state.show_names,
        "a player relabelled the board five other people are looking at"
    );
}

#[test]
fn the_switch_reaches_the_table_and_the_dm_alike() {
    // The opposite of the walls beside it in `message_for`: this is the one
    // thing the DM decides that everybody is told, because a board labelled
    // one way for the DM and another way for the table is the bug.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), ClientMsg::SetShowNames { show: false });

    // Echoed to the DM who sent it: nothing here is predicted locally, so
    // this frame is how their own checkbox settles.
    assert!(
        matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::NamesChanged { show: false }]
        ),
        "the DM was not told their own switch landed"
    );
    assert!(
        matches!(
            drain(&mut saelyn).as_slice(),
            [ServerMsg::NamesChanged { show: false }]
        ),
        "the table was not told the names came off"
    );
}

#[test]
fn the_switch_is_in_every_snapshot_and_survives_the_save_file() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), ClientMsg::SetShowNames { show: false });

    // Invariant 3, and the unusual direction of it: the join snapshot goes
    // through the same filter as the delta, and for this one field that
    // filter is the identity.
    assert!(!state.snapshot_for(&Identity::Dm).show_names);
    assert!(!state.snapshot_for(&as_player("saelyn")).show_names);

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = reboot(saved);

    assert!(
        !restored.show_names,
        "a switch the DM flipped once should be found flipped next week"
    );
}

// --- hidden tokens and hit points ---------------------------------------

#[test]
fn a_hidden_token_is_absent_from_a_players_snapshot_and_present_in_the_dms() {
    // Invariant 3: the join snapshot narrows the same way a delta does. The
    // classic way this leaks is to filter deltas correctly and then hand
    // over the whole world on connect.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), create_hidden("Ambusher"));

    let theirs = state.snapshot_for(&as_player("saelyn"));
    let ours = state.snapshot_for(&Identity::Dm);

    assert!(!names(&theirs).contains(&"Ambusher"));
    assert!(names(&ours).contains(&"Ambusher"));
    assert_eq!(
        theirs.tokens.len() + 1,
        ours.tokens.len(),
        "only the hidden one should have gone"
    );
}

#[test]
fn a_hidden_monster_is_nowhere_in_the_json_a_player_is_sent() {
    // Invariant 4 the way it actually has to be checked: not "the client
    // does not draw it" but "the bytes are not there to be found".
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        match create_hidden("Ambusher") {
            ClientMsg::CreateToken {
                name,
                img,
                size,
                owner,
                x,
                y,
                hidden,
                staged,
                ..
            } => ClientMsg::CreateToken {
                name,
                img,
                size,
                owner,
                x,
                y,
                hidden,
                hp: Some(Hp {
                    current: 4242,
                    max: 4242,
                }),
                staged,
            },
            other => other,
        },
    );

    let json = serde_json::to_string(&state.snapshot_for(&as_player("saelyn"))).expect("encodes");
    assert!(!json.contains("Ambusher"), "the name reached the table");
    assert!(!json.contains("4242"), "the hit points reached the table");
}

#[test]
fn hiding_a_token_takes_it_off_the_table_and_leaves_it_on_the_dms_board() {
    // The one event, two messages case the split between `Event` and
    // `ServerMsg` exists for.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

    match drain(&mut saelyn).as_slice() {
        [ServerMsg::TokenRemoved { id }] => assert_eq!(id, &TokenId::new("t6")),
        other => panic!("the table should have been told it is gone: {other:?}"),
    }
    match drain(&mut dm).as_slice() {
        [ServerMsg::TokenChanged { token }] => {
            assert!(token.hidden, "the DM keeps it, marked");
        }
        other => panic!("the DM should still have it: {other:?}"),
    }
}

#[test]
fn editing_an_already_hidden_token_tells_the_table_nothing() {
    // A `TokenRemoved` naming an id the players never held would tell them a
    // token exists — which is the entire thing being withheld.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let ogre = token(&state, "t6");
    state.handle(
        ClientId(1),
        match edit(&ogre) {
            ClientMsg::UpdateToken {
                id,
                img,
                size,
                owner,
                hidden,
                hp,
                ..
            } => ClientMsg::UpdateToken {
                id,
                name: "Ogre (bloodied)".to_owned(),
                img,
                size,
                owner,
                hidden,
                hp,
            },
            other => other,
        },
    );

    assert!(
        drain(&mut saelyn).is_empty(),
        "a token they were never told about has no news"
    );
}

#[test]
fn a_token_created_hidden_is_never_announced() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), create_hidden("Ambusher"));

    assert!(drain(&mut saelyn).is_empty());
    assert!(made(&state, "Ambusher").hidden);
}

#[test]
fn unhiding_a_token_is_a_creation_as_far_as_the_table_is_concerned() {
    // The ambush springs. `TokenChanged` for an id the client has not seen
    // is the creation, which is why one message covers both.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), create_hidden("Ambusher"));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), set_hidden(&made(&state, "Ambusher"), false));

    match drain(&mut saelyn).as_slice() {
        [ServerMsg::TokenChanged { token }] => assert_eq!(token.name, "Ambusher"),
        other => panic!("the table should meet it now: {other:?}"),
    }
}

#[test]
fn a_hidden_tokens_movement_is_not_relayed_to_the_table() {
    // Thirty frames a second of position would trace an invisible monster's
    // path across the board even with the token itself withheld.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    for dragging in [true, false] {
        state.handle(
            ClientId(1),
            ClientMsg::MoveToken {
                id: TokenId::new("t6"),
                x: 2.4,
                y: 8.1,
                dragging,
                staged: false,
            },
        );
    }

    assert!(drain(&mut saelyn).is_empty(), "the table watched it move");
    assert!(
        drain(&mut dm)
            .iter()
            .any(|m| matches!(m, ServerMsg::TokenMoved { .. })),
        "the DM still needs the settled position"
    );
}

#[test]
fn deleting_a_hidden_token_tells_the_table_nothing() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(
        ClientId(1),
        ClientMsg::DeleteToken {
            id: TokenId::new("t6"),
        },
    );

    assert!(!state.tokens.contains_key(&TokenId::new("t6")));
    assert!(drain(&mut saelyn).is_empty());
}

#[test]
fn hit_points_reach_the_dm_and_nobody_else() {
    // The per-field redaction this milestone exists to invent: the token is
    // one the table can see, and one field of it is not theirs.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    let ogre = token(&state, "t6");
    state.handle(
        ClientId(1),
        match edit(&ogre) {
            ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                owner,
                hidden,
                ..
            } => ClientMsg::UpdateToken {
                id,
                name,
                img,
                size,
                owner,
                hidden,
                hp: Some(Hp {
                    current: 22,
                    max: 59,
                }),
            },
            other => other,
        },
    );

    let hp_of = |frames: &[ServerMsg]| match frames {
        [ServerMsg::TokenChanged { token }] => token.hp,
        other => panic!("expected one TokenChanged, got {other:?}"),
    };
    assert_eq!(
        hp_of(&drain(&mut dm)),
        Some(Hp {
            current: 22,
            max: 59
        })
    );
    assert_eq!(
        hp_of(&drain(&mut saelyn)),
        None,
        "hit points are the DM's note"
    );

    // And on the snapshot too, by the same route rather than a second one.
    let ogre_in = |view: &RoomView| {
        view.tokens
            .iter()
            .find(|t| t.name == "Ogre")
            .expect("the ogre")
            .hp
    };
    assert!(ogre_in(&state.snapshot_for(&Identity::Dm)).is_some());
    assert_eq!(ogre_in(&state.snapshot_for(&as_player("saelyn"))), None);
}

#[test]
fn hit_points_are_bounded() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let ogre = token(&state, "t6");

    let with_hp = |hp: Option<Hp>| match edit(&ogre) {
        ClientMsg::UpdateToken {
            id,
            name,
            img,
            size,
            owner,
            hidden,
            ..
        } => ClientMsg::UpdateToken {
            id,
            name,
            img,
            size,
            owner,
            hidden,
            hp,
        },
        other => other,
    };

    for good in [
        None,
        Some(Hp { current: 0, max: 0 }),
        // Below zero is bookkeeping, and above `max` is the DM's business:
        // what a hit point *means* is the rules knowledge this does not have.
        Some(Hp {
            current: -7,
            max: 40,
        }),
        Some(Hp {
            current: 12,
            max: 4,
        }),
        Some(Hp {
            current: MAX_HP,
            max: MAX_HP,
        }),
    ] {
        assert!(
            state.check(ClientId(1), &with_hp(good)).is_ok(),
            "{good:?} should be fine"
        );
    }
    for bad in [
        Some(Hp {
            current: MAX_HP + 1,
            max: 10,
        }),
        Some(Hp {
            current: 10,
            max: -MAX_HP - 1,
        }),
    ] {
        assert!(
            state.check(ClientId(1), &with_hp(bad)).is_err(),
            "{bad:?} should be refused"
        );
    }
}

#[test]
fn a_hidden_creatures_row_is_not_on_the_tables_initiative_panel() {
    // Otherwise the panel that is always on screen names the one thing the
    // DM just took off the board — and names it with a bare id, because the
    // client has no token to look the name up on.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    for (id, value) in [("t1", 20), ("t6", 15), ("t7", 10)] {
        state.handle(
            ClientId(1),
            ClientMsg::SetInitiative {
                token: TokenId::new(id),
                value,
            },
        );
    }
    state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

    assert_eq!(order(&state.initiative_for(true)), ["t1", "t6", "t7"]);
    assert_eq!(order(&state.initiative_for(false)), ["t1", "t7"]);
    assert_eq!(
        state.initiative_for(false).round,
        state.initiative.round,
        "the round is not a secret"
    );
}

#[test]
fn the_turn_is_withheld_while_it_belongs_to_something_hidden() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("t6"),
            value: 15,
        },
    );
    state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));
    state.handle(ClientId(1), ClientMsg::NextTurn);

    assert_eq!(current(&state.initiative_for(true)), Some("t6"));
    assert_eq!(
        current(&state.initiative_for(false)),
        None,
        "a token id is data, even when it is only the turn marker"
    );
}

#[test]
fn hiding_a_creature_that_is_in_the_order_rebuilds_the_tables_panel() {
    // The panel is not otherwise rebuilt by a token edit, so without this
    // the table keeps a row naming a token their client has just forgotten.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("t6"),
            value: 15,
        },
    );
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), set_hidden(&token(&state, "t6"), true));

    match drain(&mut saelyn).as_slice() {
        [
            ServerMsg::TokenRemoved { .. },
            ServerMsg::InitiativeChanged { initiative },
        ] => {
            assert!(initiative.entries.is_empty(), "the row should have gone");
        }
        other => panic!("expected the token and the row to go together: {other:?}"),
    }
}

#[test]
fn an_edit_that_leaves_hidden_alone_does_not_rebuild_the_panel() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("t6"),
            value: 15,
        },
    );

    let events = state.apply(ClientId(1), edit(&token(&state, "t6")));

    assert!(
        matches!(events.as_slice(), [Event::TokenChanged { .. }]),
        "an untouched initiative panel should not be rebuilt: {events:?}"
    );
}

#[test]
fn a_hidden_token_and_its_hit_points_survive_the_save_file() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), create_hidden("Ambusher"));

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = reboot(saved);

    assert!(
        made(&restored, "Ambusher").hidden,
        "an ambush set up last week is still set up tonight"
    );
}

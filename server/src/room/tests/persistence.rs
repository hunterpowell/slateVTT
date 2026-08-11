//! Surviving a restart, and surviving a number that is not a number.

use super::*;

// --- non-finite numbers -------------------------------------------------

#[test]
fn a_non_finite_coordinate_is_refused_before_it_can_reach_the_save_file() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let msg = ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: bad,
            y: 0.0,
            dragging: false,
            staged: false,
        };
        assert!(
            state.check(ClientId(1), &msg).is_err(),
            "{bad} should be refused"
        );

        let msg = ClientMsg::MoveToken {
            id: TokenId::new("t1"),
            x: 0.0,
            y: bad,
            dragging: true,
            staged: false,
        };
        assert!(
            state.check(ClientId(1), &msg).is_err(),
            "{bad} should be refused"
        );

        assert!(
            state
                .check(ClientId(1), &set_map("/a.png", bad, 0.0, 0.0))
                .is_err()
        );
        assert!(
            state
                .check(ClientId(1), &set_map("/a.png", 64.0, bad, 0.0))
                .is_err()
        );
        assert!(
            state
                .check(ClientId(1), &set_map("/a.png", 64.0, 0.0, bad))
                .is_err()
        );
    }
}

#[test]
fn a_number_that_only_overflows_once_narrowed_to_f32_is_still_caught() {
    // The path that makes the check above worth having. `NaN` is not valid
    // JSON and `1e400` is rejected as out of range, so both stop at the
    // parser — but `1e39` is an ordinary `f64` that becomes infinity on the
    // way into an `f32` field, and arrives looking like a normal number.
    let raw = r#"{"type":"move_token","id":"t1","x":1e39,"y":0.0,"dragging":false,"staged":false}"#;
    let msg: ClientMsg = serde_json::from_str(raw).expect("this parses; that is the point");
    assert!(
        matches!(msg, ClientMsg::MoveToken { x, .. } if !x.is_finite()),
        "expected the narrowing to have produced infinity"
    );

    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let before = state.tokens.get(&TokenId::new("t1")).expect("t1").x;

    state.handle(ClientId(1), msg);

    assert_eq!(
        state.tokens.get(&TokenId::new("t1")).expect("t1").x,
        before,
        "it got through"
    );
}

#[test]
fn a_room_holding_a_non_finite_number_could_not_be_reloaded() {
    // The reason the check above exists, pinned so nobody relaxes it: this
    // is what would have been written to disk, and it does not come back.
    let json = serde_json::to_string(&f32::NAN).expect("encodes");
    assert_eq!(json, "null");
    assert!(
        serde_json::from_str::<f32>(&json).is_err(),
        "a saved NaN is unloadable"
    );
}

// --- persistence --------------------------------------------------------

#[tokio::test]
async fn shutdown_flushes_a_change_still_inside_the_debounce_window() {
    let path = std::env::temp_dir().join(format!(
        "slate-shutdown-test-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let room = spawn(SECRET.to_owned(), None, Store::new(path.clone()));
    let (out, mut replies) = mpsc::channel(CLIENT_MAILBOX);

    assert!(
        room.send(RoomCmd::Connected {
            client: ClientId(1),
            out,
        })
        .await
    );
    assert!(
        room.send(RoomCmd::Msg {
            client: ClientId(1),
            msg: ClientMsg::Hello {
                dm_secret: Some(SECRET.to_owned()),
                player_id: None,
            },
        })
        .await
    );
    assert!(matches!(
        replies.recv().await,
        Some(ServerMsg::Welcome { .. })
    ));

    assert!(
        room.send(RoomCmd::Msg {
            client: ClientId(1),
            msg: ClientMsg::MoveToken {
                id: TokenId::new("t6"),
                x: 9.2,
                y: 11.8,
                dragging: false,
                staged: false,
            },
        })
        .await
    );

    // This happens immediately, well before the two-second debounce.
    assert!(room.shutdown().await);

    let loaded = Store::new(path.clone())
        .load()
        .await
        .expect("shutdown save loads")
        .expect("shutdown wrote a save");
    let ogre = loaded
        .tokens
        .iter()
        .find(|token| token.id == TokenId::new("t6"))
        .expect("the ogre was saved");
    assert_eq!((ogre.x, ogre.y), (9.5, 11.5));

    let _ = std::fs::remove_file(path);
}

#[test]
fn a_drag_frame_is_not_worth_saving_but_the_drop_is() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    let at = |dragging| ClientMsg::MoveToken {
        id: TokenId::new("t2"),
        x: 6.3,
        y: 5.1,
        dragging,
        staged: false,
    };

    assert!(
        !state.handle(ClientId(1), at(true)),
        "a drag frame must not hit the disk"
    );
    assert!(
        state.handle(ClientId(1), at(false)),
        "the drop is the position worth keeping"
    );
}

#[test]
fn initiative_edits_are_worth_saving() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    let commands = [
        ClientMsg::SetInitiative {
            token: TokenId::new("t1"),
            value: 15,
        },
        ClientMsg::NextTurn,
        ClientMsg::PreviousTurn,
        ClientMsg::RemoveFromInitiative {
            token: TokenId::new("t1"),
        },
        ClientMsg::ClearInitiative,
    ];

    for cmd in commands {
        let description = format!("{cmd:?}");
        assert!(
            state.handle(ClientId(1), cmd),
            "{description} should be persisted"
        );
    }
}

#[test]
fn a_refused_command_is_not_worth_saving() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    let steal = ClientMsg::MoveToken {
        id: TokenId::new("t1"),
        x: 1.5,
        y: 1.5,
        dragging: false,
        staged: false,
    };
    assert!(
        !state.handle(ClientId(1), steal),
        "nothing changed, so nothing to write"
    );
}

#[test]
fn joining_is_not_worth_saving() {
    // Who is connected is not part of the room; it dies with the process.
    let mut state = room();
    let mut rx = connect(&mut state, ClientId(1));

    let hello = ClientMsg::Hello {
        dm_secret: None,
        player_id: Some(PlayerId::new("saelyn")),
    };
    assert!(!state.handle(ClientId(1), hello));
    assert!(
        matches!(rx.try_recv(), Ok(ServerMsg::Welcome { .. })),
        "still admitted"
    );
}

#[test]
fn a_restored_room_is_the_room_that_was_saved() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("t6"),
            x: 9.2,
            y: 11.8,
            dragging: false,
            staged: false,
        },
    );
    state.handle(
        ClientId(1),
        ClientMsg::SetInitiative {
            token: TokenId::new("t6"),
            value: 17,
        },
    );
    state.handle(ClientId(1), ClientMsg::NextTurn);

    // Through JSON rather than straight through the structs: the file is the
    // contract, and a field that fails to serialize would pass otherwise.
    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = RoomState::restored(saved, SECRET.to_owned());

    assert_eq!(restored.tokens.len(), state.tokens.len());
    let ogre = restored
        .tokens
        .get(&TokenId::new("t6"))
        .expect("the ogre survived");
    assert_eq!(
        (ogre.x, ogre.y),
        (9.5, 11.5),
        "grid units, exactly as they were stored"
    );
    assert_eq!(ogre.owner, Owner::Dm);
    assert_eq!(ogre.name, "Ogre");

    assert_eq!(restored.initiative.current, Some(TokenId::new("t6")));
    assert_eq!(restored.initiative.entries.len(), 1);
    assert_eq!(restored.map.url, state.map.url);

    assert!(
        restored.clients.is_empty(),
        "nobody is connected to a room off disk"
    );
    assert_eq!(
        restored.roster.len(),
        ROSTER.len(),
        "the roster comes from the build, not the file"
    );
}

#[test]
fn a_restored_room_still_enforces_ownership() {
    // The point of persisting `owner`: a player who reconnects after a
    // restart gets their token back and no one else's.
    let mut state = RoomState::restored(room().to_saved(), SECRET.to_owned());
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");
    let client = state.clients.get(&ClientId(1)).expect("joined");

    assert!(can_move(
        client,
        state
            .tokens
            .get(&TokenId::new("t2"))
            .expect("Saelyn's token")
    ));
    assert!(!can_move(
        client,
        state
            .tokens
            .get(&TokenId::new("t1"))
            .expect("Cleodara's token")
    ));
    assert!(!can_move(
        client,
        state.tokens.get(&TokenId::new("t6")).expect("the ogre")
    ));
}

#[test]
fn the_saved_token_order_is_stable() {
    // `HashMap` order varies per process, so without a sort the file would
    // come out differently on every save and diff against itself.
    let state = room();
    let ids: Vec<_> = state
        .to_saved()
        .tokens
        .iter()
        .map(|t| t.id.clone())
        .collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted);
}

#[test]
fn snapshot_order_is_stable() {
    let state = room();
    let ids: Vec<_> = state
        .snapshot_for(&Identity::Dm)
        .tokens
        .iter()
        .map(|t| t.id.clone())
        .collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted);
}

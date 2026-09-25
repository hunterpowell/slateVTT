//! The DM editing the cast. See `docs/rooms.md`.
//!
//! The roster is identity: a slot's id is what `hello` accepts, what a token's
//! `owner` is written as, and what a colour and a scratchpad are keyed on. So
//! most of what is asserted here is about removal, and most of that is about
//! what somebody was *not* left holding: a connection as nobody, a token nobody
//! can join to move, or the last person's paragraph handed to the next person
//! given the same name.

use super::*;

/// The whole cast, as the DM's table tab sends it.
fn cast(slots: &[(&str, &str)]) -> ClientMsg {
    ClientMsg::SetRoster {
        roster: roster_from(slots),
    }
}

fn ids(state: &RoomState) -> Vec<&str> {
    state
        .roster
        .iter()
        .map(|entry| entry.id.0.as_str())
        .collect()
}

/// Every roster one connection was sent after joining.
fn casts(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<Vec<(String, String)>> {
    drain_all(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::RosterChanged { roster } => Some(
                roster
                    .into_iter()
                    .map(|entry| (entry.id.0, entry.name))
                    .collect(),
            ),
            _ => None,
        })
        .collect()
}

/// A room with nobody's tokens on it, so any slot can be removed.
fn empty_room(slots: &[(&str, &str)]) -> RoomState {
    booted(RoomState::blank(SECRET.to_owned(), roster_from(slots)))
}

fn refusal(rx: &mut mpsc::Receiver<ServerMsg>) -> String {
    match drain(rx).as_slice() {
        [ServerMsg::Error { message }] => message.clone(),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

// --- who may -----------------------------------------------------------------

#[test]
fn a_player_may_not_edit_the_roster_and_nobody_is_told_they_tried() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut dm, &mut saelyn, &mut torrin]);
    let before = state.roster.clone();

    state.handle(ClientId(2), cast(&[("saelyn", "Saelyn, Queen of All")]));

    assert!(refusal(&mut saelyn).contains("only the DM"));
    assert_eq!(
        ids(&state),
        before.iter().map(|e| e.id.0.as_str()).collect::<Vec<_>>()
    );
    assert!(casts(&mut dm).is_empty(), "the DM was not told of it");
    assert!(
        casts(&mut torrin).is_empty(),
        "and the player the edit would have removed was not either"
    );
    assert!(state.clients.contains_key(&ClientId(3)), "nor removed");
}

// --- adding and renaming ---------------------------------------------------

#[test]
fn a_new_player_reaches_everyone_and_can_join() {
    let mut state = empty_room(&[("elias", "Elias")]);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut elias = join_as_player(&mut state, ClientId(2), "elias");
    // Somebody on the picker, who is sent the slots rather than the roster.
    let mut undecided = connect(&mut state, ClientId(3));
    state.handle(
        ClientId(3),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: None,
        },
    );
    settle(&mut [&mut dm, &mut elias, &mut undecided]);

    state.handle(ClientId(1), cast(&[("elias", "Elias"), ("mira", "Mira")]));

    let expected = vec![vec![
        ("elias".to_owned(), "Elias".to_owned()),
        ("mira".to_owned(), "Mira".to_owned()),
    ]];
    assert_eq!(casts(&mut dm), expected, "the DM, whose tab sent it");
    assert_eq!(casts(&mut elias), expected, "a player already seated");
    match drain_all(&mut undecided).as_slice() {
        [ServerMsg::ChooseIdentity { roster }] => {
            let offered: Vec<&str> = roster.iter().map(|slot| slot.id.0.as_str()).collect();
            assert_eq!(
                offered,
                vec!["elias", "mira"],
                "the picker offers the new slot"
            );
        }
        other => panic!("expected the picker to be refreshed, got {other:?}"),
    }

    state.handle(
        ClientId(3),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new("mira")),
        },
    );
    assert!(
        matches!(
            undecided.try_recv(),
            Ok(ServerMsg::Welcome { player_id: Some(id), .. }) if id.0 == "mira"
        ),
        "and whoever picks it is let in as them"
    );
}

#[test]
fn a_rename_keeps_the_id_and_everything_keyed_on_it() {
    // The id is what a token, a colour and a claimed browser point at, so a
    // rename that changed it would orphan all three. The display name is the
    // only thing that moves.
    let mut state = room();
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(2), ClientMsg::SetColour { colour: 3 });
    settle(&mut [&mut saelyn]);

    let mut renamed: Vec<(String, String)> = ROSTER
        .iter()
        .map(|(id, name)| ((*id).to_owned(), (*name).to_owned()))
        .collect();
    renamed[1].1 = "Saelyn the Bold".to_owned();
    let slots: Vec<(&str, &str)> = renamed
        .iter()
        .map(|(i, n)| (i.as_str(), n.as_str()))
        .collect();
    state.handle(dm, cast(&slots));

    assert_eq!(state.roster[1].name, "Saelyn the Bold");
    assert!(
        state.clients.contains_key(&ClientId(2)),
        "she is still here"
    );
    assert_eq!(state.colours.get(&PlayerId::new("saelyn")), Some(&3));
    assert_eq!(
        token(&state, "t2").owner,
        Owner::Player(PlayerId::new("saelyn"))
    );
    assert_eq!(
        casts(&mut saelyn).len(),
        1,
        "and her own screen was told the new name"
    );
}

// --- removing ----------------------------------------------------------------

#[test]
fn a_slot_that_owns_a_token_cannot_be_removed() {
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm_rx, &mut saelyn]);

    let without: Vec<(&str, &str)> = ROSTER
        .iter()
        .copied()
        .filter(|(id, _)| *id != "saelyn")
        .collect();
    state.handle(dm, cast(&without));

    let message = refusal(&mut dm_rx);
    assert!(
        message.contains("Saelyn") && message.contains("token"),
        "{message}"
    );
    assert!(ids(&state).contains(&"saelyn"));
    assert!(
        state.clients.contains_key(&ClientId(2)),
        "she was not disconnected"
    );
    assert!(casts(&mut saelyn).is_empty(), "and was sent nothing");
}

#[test]
fn a_staged_token_counts_as_owning_one() {
    // A token built on the next map is still somebody's creature, and would be
    // orphaned on the promote.
    let mut state = empty_room(&[("elias", "Elias")]);
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);
    state.handle(dm, set_map("/uploads/next.png", 70.0, 0.0, 0.0));
    state.handle(
        dm,
        ClientMsg::SetMap {
            url: "/uploads/later.png".to_owned(),
            grid_px: 70.0,
            offset_x: 0.0,
            offset_y: 0.0,
            grid_color: "#ffffff52".to_owned(),
            play_area: None,
            fog: false,
            vision_ft: 60.0,
            lighting: Lighting::Dynamic,
            grid_shape: GridShape::Square,
            staged: true,
        },
    );
    state.handle(
        dm,
        with(
            create("Elias Later", 1.0, Owner::Player(PlayerId::new("elias"))),
            |_, staged| *staged = true,
        ),
    );
    assert!(made(&state, "Elias Later").staged_only);
    drain(&mut dm_rx);

    state.handle(dm, cast(&[]));

    assert!(refusal(&mut dm_rx).contains("token"));
    assert_eq!(ids(&state), vec!["elias"]);
}

#[test]
fn a_removed_player_is_disconnected_and_their_colour_and_notes_go_with_them() {
    let mut state = empty_room(&[("elias", "Elias"), ("corvus", "Corvus")]);
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut elias = join_as_player(&mut state, ClientId(2), "elias");
    let mut corvus = join_as_player(&mut state, ClientId(3), "corvus");
    state.handle(ClientId(2), ClientMsg::SetColour { colour: 4 });
    state.handle(
        ClientId(2),
        ClientMsg::SetNotes {
            text: "Corvus owes me 10gp".to_owned(),
        },
    );
    settle(&mut [&mut dm_rx, &mut elias, &mut corvus]);

    state.handle(dm, cast(&[("corvus", "Corvus")]));

    assert_eq!(ids(&state), vec!["corvus"]);
    assert!(
        !state.clients.contains_key(&ClientId(2)),
        "Elias's socket is gone"
    );
    assert!(state.colours.is_empty(), "with his colour");
    assert!(
        !state
            .notes
            .contains_key(&Owner::Player(PlayerId::new("elias"))),
        "and his scratchpad"
    );

    // His connection was closed, not left open as somebody the room no longer
    // has. Whatever was queued before is still readable, and after it the
    // channel reports the room dropped its end.
    let his = drain_all(&mut elias);
    assert!(
        !his.iter()
            .any(|msg| matches!(msg, ServerMsg::RosterChanged { .. })),
        "he was removed before the new roster went out: {his:?}"
    );
    assert!(matches!(
        elias.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
    ));

    // Everybody still here hears all three: the cast, the colours and who is
    // connected.
    let theirs = drain_all(&mut corvus);
    assert!(
        theirs
            .iter()
            .any(|m| matches!(m, ServerMsg::RosterChanged { roster } if roster.len() == 1))
    );
    assert!(
        theirs
            .iter()
            .any(|m| matches!(m, ServerMsg::ColoursChanged { colours } if colours.is_empty()))
    );
    assert!(theirs.iter().any(|m| matches!(
        m,
        ServerMsg::Presence { here } if !here.contains(&Owner::Player(PlayerId::new("elias")))
    )));
}

#[test]
fn a_removed_slug_is_no_longer_an_identity() {
    // What his page does next: it reconnects offering the slug it remembered,
    // and is shown the picker rather than being let back in as nobody.
    let mut state = empty_room(&[("elias", "Elias")]);
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);
    let _elias = join_as_player(&mut state, ClientId(2), "elias");
    state.handle(dm, cast(&[]));

    let mut back = connect(&mut state, ClientId(9));
    state.handle(
        ClientId(9),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new("elias")),
        },
    );
    match back.try_recv() {
        Ok(ServerMsg::ChooseIdentity { roster }) => assert!(roster.is_empty()),
        other => panic!("expected the picker, got {other:?}"),
    }
}

#[test]
fn a_name_added_again_is_not_sent_the_last_persons_scratchpad() {
    // Adding a name the DM removed earlier makes the same id, so anything left
    // under it would be handed to whoever takes the slot next. The paragraph
    // is the one that matters: it was private to somebody else.
    let mut state = empty_room(&[("elias", "Elias")]);
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);
    let _elias = join_as_player(&mut state, ClientId(2), "elias");
    state.handle(
        ClientId(2),
        ClientMsg::SetNotes {
            text: "my secret plan".to_owned(),
        },
    );
    state.handle(dm, cast(&[]));
    state.handle(dm, cast(&[("elias", "Elias")]));

    let mut next = connect(&mut state, ClientId(5));
    state.handle(
        ClientId(5),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new("elias")),
        },
    );
    match next.try_recv() {
        Ok(ServerMsg::Welcome { state: view, .. }) => assert_eq!(view.notes, ""),
        other => panic!("expected a welcome, got {other:?}"),
    }
}

// --- what a roster may be ------------------------------------------------------

#[test]
fn a_roster_that_breaks_a_rule_is_refused_whole() {
    let long_name = "x".repeat(MAX_PLAYER_NAME_LEN + 1);
    let long_id = "x".repeat(MAX_PLAYER_ID_LEN + 1);
    let too_many: Vec<(String, String)> = (0..=MAX_ROSTER)
        .map(|i| (format!("p{i}"), format!("P{i}")))
        .collect();
    let too_many: Vec<(&str, &str)> = too_many
        .iter()
        .map(|(i, n)| (i.as_str(), n.as_str()))
        .collect();

    // What the case is, the roster sent, and a word the refusal must contain.
    type Case<'a> = (&'a str, Vec<(&'a str, &'a str)>, &'a str);
    let cases: Vec<Case> = vec![
        ("an id with a space", vec![("iron beak", "Iron Beak")], "id"),
        ("an id with a capital", vec![("Elias", "Elias")], "id"),
        ("an empty id", vec![("", "Nobody")], "id"),
        ("an overlong id", vec![(long_id.as_str(), "Long")], "id"),
        (
            "two slots with one id",
            vec![("elias", "Elias"), ("elias", "Also Elias")],
            "both",
        ),
        ("a blank name", vec![("elias", "   ")], "name"),
        (
            "an overlong name",
            vec![("elias", long_name.as_str())],
            "characters",
        ),
        ("more players than a room holds", too_many, "holds"),
    ];

    for (what, slots, says) in cases {
        let mut state = empty_room(&[("elias", "Elias")]);
        let dm = ClientId(1);
        let mut dm_rx = join_as_dm(&mut state, dm);
        drain(&mut dm_rx);

        state.handle(dm, cast(&slots));

        let message = refusal(&mut dm_rx);
        assert!(message.contains(says), "{what}: {message}");
        assert_eq!(ids(&state), vec!["elias"], "{what} changed nothing");
    }
}

#[test]
fn a_room_with_nobody_on_the_roster_still_lets_the_dm_in() {
    // A new site's room starts like this: the DM needs no slot, and adds the
    // players from the table tab before the first session.
    let mut state = empty_room(&[]);
    let mut dm = connect(&mut state, ClientId(1));
    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: Some(SECRET.to_owned()),
            player_id: None,
        },
    );
    assert!(matches!(
        dm.try_recv(),
        Ok(ServerMsg::Welcome { is_dm: true, .. })
    ));

    let mut player = connect(&mut state, ClientId(2));
    state.handle(
        ClientId(2),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: None,
        },
    );
    assert!(matches!(
        player.try_recv(),
        Ok(ServerMsg::ChooseIdentity { roster }) if roster.is_empty()
    ));
}

#[test]
fn the_largest_roster_fits_in_a_frame() {
    // The count is refused in `check`, which never runs on a frame the socket
    // dropped. Four-byte characters, so nothing here is cheaper to send than a
    // real name could be.
    let slots: Vec<(String, String)> = (0..MAX_ROSTER)
        .map(|i| {
            (
                format!("{i:0>width$}", width = MAX_PLAYER_ID_LEN),
                "𝔄".repeat(MAX_PLAYER_NAME_LEN),
            )
        })
        .collect();
    let slots: Vec<(&str, &str)> = slots
        .iter()
        .map(|(i, n)| (i.as_str(), n.as_str()))
        .collect();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "type": "set_roster",
        "roster": roster_from(&slots),
    }))
    .expect("encodes");

    let parsed: ClientMsg = serde_json::from_slice(&bytes).expect("the server parses its own");
    assert!(matches!(parsed, ClientMsg::SetRoster { roster } if roster.len() == MAX_ROSTER));
    assert!(bytes.len() <= crate::MAX_WS_MESSAGE_BYTES);
}

// --- the disk and the undo ring ------------------------------------------------

#[test]
fn the_roster_survives_a_restart() {
    let mut state = empty_room(&[("elias", "Elias")]);
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);
    state.handle(dm, cast(&[("elias", "Elias"), ("mira", "Mira")]));

    // `reboot` hands the constructor the campaign's seed. The file wins.
    let booted = reboot(state.to_saved());
    assert_eq!(ids(&booted), vec!["elias", "mira"]);
}

#[test]
fn a_save_from_before_the_roster_was_saved_keeps_the_seed() {
    // Invariant 2 on a field that had to be an `Option`: loading this file as
    // an empty roster would turn the whole campaign away at the door on the
    // first boot after the upgrade.
    let saved: Saved =
        serde_json::from_str(r#"{"map":{"url":"/assets/map.png"}}"#).expect("an old save loads");
    assert!(saved.roster.is_none());

    let booted = reboot(saved);
    assert_eq!(ids(&booted).len(), ROSTER.len());
    assert_eq!(ids(&booted)[0], ROSTER[0].0);
}

#[test]
fn editing_the_roster_is_not_a_step_and_an_undo_leaves_it_alone() {
    assert!(undid(&cast(&[])).is_none());

    let mut state = empty_room(&[("elias", "Elias")]);
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);
    // A DM command either side of the edit, so the ring holds a snapshot from
    // before it and one from after.
    state.handle(dm, ClientMsg::SetShowNames { show: false });
    state.handle(dm, cast(&[("elias", "Elias"), ("mira", "Mira")]));
    assert_eq!(state.undo_label().as_deref(), Some("the name switch"));
    let _mira = join_as_player(&mut state, ClientId(2), "mira");
    state.handle(dm, ClientMsg::SetShowNames { show: true });

    state.handle(dm, ClientMsg::Undo);
    state.handle(dm, ClientMsg::Undo);

    assert!(state.show_names, "the DM's switch went back twice");
    assert_eq!(ids(&state), vec!["elias", "mira"], "and the cast did not");
    assert!(
        state.clients.contains_key(&ClientId(2)),
        "so Mira is still here as herself"
    );
}

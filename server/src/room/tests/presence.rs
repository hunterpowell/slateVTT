//! Who is here, and what colour they draw in. See `docs/presence.md`.
//!
//! **Two features that share a strip and share almost nothing else**, which is
//! why one file holds both: presence is the room reporting on its own sockets
//! and belongs to nobody, and a colour is a player's own state written into a
//! table everybody reads. The assertions split the same way — the first half is
//! about frames that arrive with no command behind them, and the second is
//! mostly about frames that never left.

use super::*;

/// Every presence frame one connection was actually sent, in order. `drain`
/// filters these out for the rest of the suite, so this reaches past it.
fn told(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<Vec<Owner>> {
    drain_all(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::Presence { here } => Some(here),
            _ => None,
        })
        .collect()
}

/// Every colour table one connection was sent. `told`'s twin.
fn palettes(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<Colours> {
    drain_all(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::ColoursChanged { colours } => Some(colours),
            _ => None,
        })
        .collect()
}

fn player(slot: &str) -> Owner {
    Owner::Player(PlayerId::new(slot))
}

fn pick(colour: u8) -> ClientMsg {
    ClientMsg::SetColour { colour }
}

/// A socket going away, as the actor loop's `Disconnected` arm does it. These
/// tests drive `RoomState` directly, so this is that arm's two lines.
fn leaves(state: &mut RoomState, client: ClientId) {
    state.clients.remove(&client);
    state.dispatch(client, &[Event::PresenceChanged]);
}

// --- who is here ----------------------------------------------------------

#[test]
fn joining_tells_everyone_already_here() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    // The helper drained the DM's own join. What arrives on it next is somebody
    // else's, which is the frame this feature exists for.
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    assert_eq!(
        told(&mut dm),
        vec![vec![Owner::Dm, player("saelyn")]],
        "the DM is told the table filled up"
    );
    // Drained by the helper, so this says only that the join left nothing extra
    // behind — the arrival learned who was here from its `Welcome`.
    assert_eq!(told(&mut saelyn), Vec::<Vec<Owner>>::new());
}

#[test]
fn the_join_snapshot_and_the_delta_agree() {
    // Invariant 3 on a field it would be easy to send as a delta and forget on
    // the snapshot — in which case the strip stays blank until the next person
    // moves, which reads as nobody being here.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    for who in [Identity::Dm, as_player("saelyn"), as_player("torrin")] {
        assert_eq!(
            state.snapshot_for(&who).here,
            vec![Owner::Dm, player("saelyn")],
            "every join carries the same list, {who:?} included"
        );
    }
}

#[test]
fn two_connections_as_one_person_are_one_entry() {
    // `RosterSlot::claimed` says a laptop and a phone are legitimate, so this
    // counts identities and not sockets. Counting sockets would seat seven
    // people at a table of six.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _laptop = join_as_player(&mut state, ClientId(2), "saelyn");
    let _phone = join_as_player(&mut state, ClientId(3), "saelyn");

    assert_eq!(
        told(&mut dm),
        vec![
            vec![Owner::Dm, player("saelyn")],
            vec![Owner::Dm, player("saelyn")],
        ],
        "two frames, because two sockets opened — and one name in both"
    );
}

#[test]
fn a_players_last_socket_closing_takes_them_off_the_strip() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _laptop = join_as_player(&mut state, ClientId(2), "saelyn");
    let _phone = join_as_player(&mut state, ClientId(3), "saelyn");
    settle(&mut [&mut dm]);

    leaves(&mut state, ClientId(2));
    assert_eq!(
        told(&mut dm),
        vec![vec![Owner::Dm, player("saelyn")]],
        "one of their two windows shut; they are still at the table"
    );

    leaves(&mut state, ClientId(3));
    assert_eq!(told(&mut dm), vec![vec![Owner::Dm]], "and now they are not");
}

#[test]
fn the_dm_leaving_is_what_the_table_is_told() {
    // The reason this carries `Owner` rather than `RosterSlot`: a list of slots
    // cannot say the DM went away, and that is the connection a table most wants
    // to be sure of.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut saelyn]);

    leaves(&mut state, ClientId(1));

    assert_eq!(told(&mut saelyn), vec![vec![player("saelyn")]]);
}

#[test]
fn a_socket_that_never_claimed_a_slot_is_nobody() {
    // Somebody sitting on the identity picker is connected and is not *here* —
    // there is no `Owner` to put on the strip, and `refresh_pickers` is what
    // that connection is told instead.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    settle(&mut [&mut dm]);

    let _undecided = connect(&mut state, ClientId(9));
    state.handle(
        ClientId(9),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: None,
        },
    );

    assert_eq!(
        told(&mut dm),
        Vec::<Vec<Owner>>::new(),
        "a socket with no identity changes nobody's strip"
    );
    assert_eq!(state.snapshot_for(&Identity::Dm).here, vec![Owner::Dm]);
}

#[test]
fn who_is_connected_is_not_part_of_the_room() {
    // The sentence the `Disconnected` arm already held, asserted: presence marks
    // nothing dirty, so it can neither reach the disk nor be undone back into
    // existence.
    assert!(!persists(&Event::PresenceChanged));

    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    let json = serde_json::to_string(&state.to_saved()).expect("a room serialises");
    assert!(
        !json.contains("here"),
        "nothing about who is connected reaches the file: {json}"
    );
}

// --- what colour they draw in ---------------------------------------------

#[test]
fn a_colour_reaches_everyone_including_whoever_picked_it() {
    // The axis this differs from a scratchpad on. Both are yours to set; only
    // one of them is any use if nobody else can see it, so this is the first
    // player-written state in the project that is public.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");
    settle(&mut [&mut dm, &mut saelyn, &mut torrin]);

    state.handle(ClientId(2), pick(4));

    let expected = Colours::from([(PlayerId::new("saelyn"), 4)]);
    for (who, rx) in [
        ("the DM", &mut dm),
        ("the player who picked", &mut saelyn),
        ("the player who did not", &mut torrin),
    ] {
        assert_eq!(
            palettes(rx),
            vec![expected.clone()],
            "{who} holds the whole table"
        );
    }
}

#[test]
fn the_table_is_on_every_join_snapshot() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut saelyn]);
    state.handle(ClientId(2), pick(1));

    for who in [Identity::Dm, as_player("torrin")] {
        assert_eq!(
            state.snapshot_for(&who).colours,
            Colours::from([(PlayerId::new("saelyn"), 1)]),
            "{who:?} is told what colour to draw Saelyn's ring in"
        );
    }
}

#[test]
fn the_command_names_no_slot_so_it_can_only_reach_the_senders_own() {
    // `Say`'s rule and `SetNotes`' rule a third time: whose colour this is comes
    // from the socket. There is no key in the frame to point anywhere else,
    // which is why this can only assert the shape of what came out.
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let _torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(2), pick(0));
    state.handle(ClientId(3), pick(0));

    assert_eq!(
        state.colours,
        Colours::from([(PlayerId::new("saelyn"), 0), (PlayerId::new("torrin"), 0)]),
        "and two people may land on the same colour: the name written beside a \
         ring is what tells them apart, which is why nothing here checks"
    );
}

#[test]
fn a_colour_outside_the_palette_is_refused() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut saelyn]);

    state.handle(ClientId(2), pick(PALETTE));

    assert!(state.colours.is_empty());
    match drain(&mut saelyn).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("colours"), "{message}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_dm_is_refused_and_the_table_is_told_nothing() {
    // Their hue sits outside the six because theirs is the one ring at the table
    // that is not a player's. Refused here rather than merely unbuilt on their
    // client, because a rule only the UI keeps is not a rule.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    state.handle(ClientId(1), pick(0));

    assert!(state.colours.is_empty());
    match drain(&mut dm).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("DM"), "{message}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        palettes(&mut saelyn),
        Vec::<Colours>::new(),
        "a refused command is nobody else's news"
    );
}

#[test]
fn a_colour_survives_a_restart() {
    // Persisted, unlike the chat log and like the scratchpads: a colour picked
    // once at the start of a campaign that had to be picked again every session
    // would not be worth picking.
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(2), pick(2));

    let booted = RoomState::restored(state.to_saved(), SECRET.to_owned());
    assert_eq!(booted.colours.get(&PlayerId::new("saelyn")), Some(&2));
}

// --- and the undo ring ----------------------------------------------------

#[test]
fn picking_a_colour_is_not_a_step_the_dm_can_take_back() {
    // Milestone 22's rule: the ring holds state the undoing hand wrote. This is
    // the second thing to need the exemption by hand, which is what turns that
    // rule from a special case into a rule.
    assert!(undid(&pick(2)).is_none());

    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm_rx]);

    state.handle(ClientId(2), pick(3));
    assert_eq!(
        state.undo_label(),
        None,
        "a player's colour did not give the DM something to undo"
    );
}

#[test]
fn an_undo_leaves_a_colour_picked_since_alone() {
    // The half `undid` cannot express, and the reason both halves are needed: a
    // colour picked *between* two commands is on the snapshot the later one
    // pushed, so a restore would put the old one back without this.
    let mut state = room();
    let dm = ClientId(1);
    let _dm_rx = join_as_dm(&mut state, dm);
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), pick(1));
    // Two DM commands with a pick in between them, so the ring holds a snapshot
    // from either side of it.
    state.handle(dm, ClientMsg::SetShowNames { show: false });
    state.handle(ClientId(2), pick(5));
    state.handle(dm, ClientMsg::SetShowNames { show: true });

    state.handle(dm, ClientMsg::Undo);

    assert!(!state.show_names, "the DM's switch went back");
    assert_eq!(
        state.colours.get(&PlayerId::new("saelyn")),
        Some(&5),
        "and the colour a player picked in between did not"
    );
}

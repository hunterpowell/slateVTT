//! Everybody's pointer on everybody's board. See `docs/presence.md`.
//!
//! **Half of this file is about a frame that did not leave**, which is the shape
//! every visibility test in this suite has — except that the line it is drawn
//! along is new. `walls.rs` asserts what a player is never told; `chat.rs`
//! asserts what one player is told and another is not. This one asserts what the
//! *DM* is not allowed to say by accident, which is the first filter here whose
//! subject is the DM's own hand.

use super::*;

/// Every pointer one connection was actually sent, in order.
fn pointers(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<(Owner, Pos)> {
    drain(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::CursorMoved { by, at } => Some((by, at)),
            _ => None,
        })
        .collect()
}

fn moved_to(x: f32, y: f32) -> ClientMsg {
    ClientMsg::MoveCursor { at: Pos { x, y } }
}

/// Where the party's own token is standing in `fog_room`, and so the one cell
/// everybody has certainly explored.
const LIT: (f32, f32) = (1.5, 1.5);
/// Where the ogre is, four cells away with two cells of vision — dark to the
/// table on every map `fog_room(10.0)` builds.
const DARK: (f32, f32) = (5.5, 1.5);

// --- the relay ------------------------------------------------------------

#[test]
fn a_pointer_reaches_everyone_but_the_hand_that_moved_it() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut cleodara = join_as_player(&mut state, ClientId(3), "cleodara");
    settle(&mut [&mut dm, &mut saelyn, &mut cleodara]);

    state.handle(ClientId(2), moved_to(3.25, 4.5));

    let sent = (
        Owner::Player(PlayerId::new("saelyn")),
        Pos { x: 3.25, y: 4.5 },
    );
    assert_eq!(pointers(&mut dm), vec![sent.clone()]);
    assert_eq!(pointers(&mut cleodara), vec![sent]);
    assert!(
        pointers(&mut saelyn).is_empty(),
        "their own pointer is drawn by their own machine; a copy a round trip \
         behind it is the rubber-band a token drag already refuses"
    );
}

#[test]
fn nothing_in_the_room_remembers_one_arrived() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    assert!(
        !state.handle(ClientId(1), moved_to(2.0, 2.0)),
        "a position true for a sixteenth of a second is not worth a disk write"
    );
    // The whole of what a cursor leaves behind, asked of the one thing that
    // could hold it: the file. There is no field to inspect because there is no
    // field at all.
    assert_eq!(state.to_saved().tokens.len(), state.tokens.len());
}

#[test]
fn pointing_at_a_dark_room_does_not_light_it() {
    // `Ping`'s rule, and for the same reason: a hand is not a torch. The
    // temptation is to write this arm of `moves_sight` the other way round,
    // which would explore the dungeon for the party as the DM prepared it.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let before = state.revealed.clone();

    state.handle(ClientId(1), moved_to(DARK.0, DARK.1));

    assert_eq!(state.revealed, before);
}

// --- the one thing withheld -----------------------------------------------

#[test]
fn the_dms_pointer_over_unexplored_ground_never_reaches_the_table() {
    // The milestone's one filter, and the assertion is a frame that never left.
    // A ping over the same cell *is* relayed — that is `drawings.rs` — and the
    // difference between the two is the whole design: a ping is a gesture
    // somebody chose to make, and this is where the DM's hand happens to be
    // while they work on the ambush.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut saelyn]);

    state.handle(ClientId(1), moved_to(DARK.0, DARK.1));
    assert!(
        pointers(&mut saelyn).is_empty(),
        "the DM's pointer resting on the monster in the dark announces the monster"
    );

    state.handle(ClientId(1), moved_to(LIT.0, LIT.1));
    assert_eq!(
        pointers(&mut saelyn),
        [(Owner::Dm, Pos { x: LIT.0, y: LIT.1 })],
        "and over ground the party is standing on it is just a pointer"
    );
}

#[test]
fn a_players_pointer_goes_wherever_they_point_it() {
    // The other three quarters of `cursor_seen`, and none of them is a leak: a
    // player can only point at what their own client drew, so a player's
    // pointer over the dark is somebody waving at a black rectangle.
    let mut state = fog_room(10.0);
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut cleodara = join_as_player(&mut state, ClientId(3), "cleodara");
    settle(&mut [&mut dm, &mut saelyn, &mut cleodara]);

    state.handle(ClientId(2), moved_to(DARK.0, DARK.1));

    let sent = (
        Owner::Player(PlayerId::new("saelyn")),
        Pos {
            x: DARK.0,
            y: DARK.1,
        },
    );
    assert_eq!(pointers(&mut cleodara), vec![sent.clone()]);
    assert_eq!(
        pointers(&mut dm),
        vec![sent],
        "the DM is sent every pointer; they can see the whole board already"
    );
}

#[test]
fn the_dms_own_paint_swallows_their_pointer_too() {
    // `known` and not `revealed`, which is the one line of `cursor_seen` a
    // reader would be tempted to simplify. A cell the party explored and the DM
    // has since blacked out is a cell the table is not looking at, so a pointer
    // over it says the same thing a pointer over unexplored ground does.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut saelyn]);

    state.handle(ClientId(1), moved_to(DARK.0, DARK.1));
    assert_eq!(
        pointers(&mut saelyn).len(),
        1,
        "sixty feet of vision reaches the ogre's cell, so this one is explored"
    );

    state.handle(
        ClientId(1),
        ClientMsg::SetFogOverride {
            cells: vec![(5, 1)],
            state: Some(Override::Dark),
            staged: false,
        },
    );
    settle(&mut [&mut saelyn]);

    state.handle(ClientId(1), moved_to(DARK.0, DARK.1));
    assert!(
        pointers(&mut saelyn).is_empty(),
        "painted dark is dark, and the DM's hand goes with it"
    );
}

#[test]
fn an_unfogged_map_withholds_nothing() {
    // The `map.fog` guard, which is `shape_seen`'s and load-bearing for the
    // identical reason: `known` is empty with the lights on, so without it the
    // DM's pointer would vanish from every board the moment fog was switched off
    // — which is most rooms, most of the time.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut saelyn]);

    state.handle(ClientId(1), moved_to(40.0, 40.0));

    assert_eq!(pointers(&mut saelyn).len(), 1);
}

// --- the switch -----------------------------------------------------------

#[test]
fn switching_them_off_stops_the_relay_rather_than_the_drawing() {
    // The reason the switch is read in `message_for` and not on the client: this
    // is the busiest message in the room, and a switch that left the frames
    // crossing the wire would be a preference rather than a dial.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    state.handle(ClientId(1), ClientMsg::SetShowCursors { show: false });
    assert!(
        matches!(
            drain(&mut saelyn).as_slice(),
            [ServerMsg::CursorsChanged { show: false }]
        ),
        "the table is told, so their clients stop sending too"
    );
    assert!(
        matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::CursorsChanged { show: false }]
        ),
        "and the DM who flipped it, which is how their own checkbox settles"
    );

    state.handle(ClientId(2), moved_to(2.0, 2.0));
    assert!(pointers(&mut dm).is_empty());

    state.handle(ClientId(1), ClientMsg::SetShowCursors { show: true });
    settle(&mut [&mut dm, &mut saelyn]);
    state.handle(ClientId(2), moved_to(2.0, 2.0));
    assert_eq!(pointers(&mut dm).len(), 1, "and back on again");
}

#[test]
fn a_pointer_sent_into_a_room_that_switched_them_off_is_not_an_error() {
    // Deliberately *not* refused in `check`. A client that has not yet been told
    // is a client mid-`pointermove`, and a red banner per frame is a worse
    // answer than a frame nobody is sent.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), ClientMsg::SetShowCursors { show: false });
    settle(&mut [&mut saelyn]);

    state.handle(ClientId(2), moved_to(2.0, 2.0));

    assert!(
        !drain(&mut saelyn)
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { .. })),
        "no error to the sender either — nobody did anything wrong"
    );
}

#[test]
fn the_switch_is_the_dms_and_a_refusal_tells_nobody() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    let refused = state
        .check(ClientId(2), &ClientMsg::SetShowCursors { show: false })
        .expect_err("a player may not set what every board draws");
    assert!(refused.contains("what the boards draw"));

    assert!(state.show_cursors, "and the room is unchanged");
    assert!(drain(&mut dm).is_empty(), "nobody is told about a refusal");
}

#[test]
fn the_switch_is_on_every_join_snapshot_and_survives_a_restart() {
    // Invariant 3 for the frame, and the reason it is on the view at all: a
    // client reads this to decide whether to *send*, so a join that omitted it
    // would have every fresh page shipping its pointer into a room that has
    // switched cursors off.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    assert!(state.snapshot_for(&as_player("saelyn")).show_cursors);
    assert!(state.snapshot_for(&Identity::Dm).show_cursors);

    state.handle(ClientId(1), ClientMsg::SetShowCursors { show: false });

    assert!(!state.snapshot_for(&as_player("saelyn")).show_cursors);
    assert!(
        !state.to_saved().show_cursors,
        "a table that decided against pointers does not decide again next week"
    );
}

#[test]
fn the_switch_is_a_step_and_a_pointer_is_not() {
    // `persists` and `undid` agreeing, which is what a step is. The interesting
    // half is the second: a ring ten deep filled with mouse movements would take
    // the DM's actual last command out of reach.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), ClientMsg::SetShowCursors { show: false });
    assert_eq!(
        state.snapshot_for(&Identity::Dm).undo.as_deref(),
        Some("the cursor switch")
    );

    state.handle(ClientId(1), moved_to(1.0, 1.0));
    assert_eq!(
        state.snapshot_for(&Identity::Dm).undo.as_deref(),
        Some("the cursor switch"),
        "moving a pointer did not push a step"
    );

    state.handle(ClientId(1), ClientMsg::Undo);
    assert!(state.show_cursors, "and the switch went back");
}

// --- the DM's own ---------------------------------------------------------

#[test]
fn switching_the_dms_off_leaves_everybody_elses_alone() {
    // The whole of what the narrow switch does, and the assertion that matters
    // is the frame that never left. The two beside it are the reason it is not
    // just `SetShowCursors` again: the other six hands go on being drawn for
    // each other, and the DM's own second tab still sees the first.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut second_tab = join_as_dm(&mut state, ClientId(4));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut cleodara = join_as_player(&mut state, ClientId(3), "cleodara");
    state.handle(ClientId(1), ClientMsg::SetShowDmCursor { show: false });
    settle(&mut [&mut dm, &mut second_tab, &mut saelyn, &mut cleodara]);

    state.handle(ClientId(1), moved_to(2.0, 2.0));
    assert!(
        pointers(&mut saelyn).is_empty(),
        "the DM put their hand away, and the table is where it goes away from"
    );
    assert_eq!(
        pointers(&mut second_tab),
        [(Owner::Dm, Pos { x: 2.0, y: 2.0 })],
        "`to_dm` is still the first line of `cursor_seen`: this withholds the \
         DM's pointer from the table, not from the DM"
    );

    state.handle(ClientId(2), moved_to(3.0, 3.0));
    let sent = (
        Owner::Player(PlayerId::new("saelyn")),
        Pos { x: 3.0, y: 3.0 },
    );
    assert_eq!(pointers(&mut cleodara), vec![sent.clone()]);
    assert_eq!(
        pointers(&mut dm),
        vec![sent],
        "and this is the switch it is not: every other pointer is untouched"
    );
}

#[test]
fn the_dm_switch_reaches_past_the_dark_onto_a_lit_map() {
    // Where it sits in `cursor_seen` is the test: after the two yeses and
    // *before* the `map.fog` guard, so it holds on an unfogged map — which is
    // most rooms, most of the time, and most of when a DM would reach for it.
    // Read the other way round it would be a switch that did nothing until the
    // fog was on, which is the one arrangement nobody would ask for.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), ClientMsg::SetShowDmCursor { show: false });
    settle(&mut [&mut saelyn]);

    state.handle(ClientId(1), moved_to(40.0, 40.0));
    assert!(
        pointers(&mut saelyn).is_empty(),
        "no fog to hide behind and nothing sent anyway"
    );

    state.handle(ClientId(1), ClientMsg::SetShowDmCursor { show: true });
    settle(&mut [&mut saelyn]);
    state.handle(ClientId(1), moved_to(40.0, 40.0));
    assert_eq!(pointers(&mut saelyn).len(), 1, "and back on again");
}

#[test]
fn the_dm_switch_is_the_dms_and_a_refusal_tells_nobody() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    let refused = state
        .check(ClientId(2), &ClientMsg::SetShowDmCursor { show: false })
        .expect_err("a player may not decide whose pointers the boards draw");
    assert!(refused.contains("whose pointers the boards draw"));

    assert!(state.show_dm_cursor, "and the room is unchanged");
    assert!(drain(&mut dm).is_empty(), "nobody is told about a refusal");
}

#[test]
fn the_dm_switch_is_told_to_everybody_and_survives_a_restart() {
    // Unfiltered like the four room-wide switches beside it: who may flip it is
    // a permission and what it says is not a secret. A player does nothing with
    // the frame — unlike `CursorsChanged`, nothing about what they send or draw
    // depends on it — and it goes to them anyway rather than earning a second
    // rule for one bool.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    settle(&mut [&mut dm, &mut saelyn]);

    assert!(state.snapshot_for(&as_player("saelyn")).show_dm_cursor);
    assert!(state.snapshot_for(&Identity::Dm).show_dm_cursor);

    state.handle(ClientId(1), ClientMsg::SetShowDmCursor { show: false });
    assert!(
        matches!(
            drain(&mut saelyn).as_slice(),
            [ServerMsg::DmCursorChanged { show: false }]
        ),
        "and the table is told, for the reason every switch on that panel is"
    );
    assert!(
        matches!(
            drain(&mut dm).as_slice(),
            [ServerMsg::DmCursorChanged { show: false }]
        ),
        "and the DM who flipped it, which is how their own checkbox settles"
    );

    assert!(!state.snapshot_for(&as_player("saelyn")).show_dm_cursor);
    assert!(
        !state.to_saved().show_dm_cursor,
        "a DM who put their pointer away on Tuesday finds it away on Saturday"
    );
}

#[test]
fn the_dm_switch_is_a_step_of_its_own() {
    // `persists` and `undid` agreeing, and the label naming this switch rather
    // than the one above it: with no redo, a press that took back a different
    // switch would be unrecoverable.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), ClientMsg::SetShowDmCursor { show: false });
    assert_eq!(
        state.snapshot_for(&Identity::Dm).undo.as_deref(),
        Some("the DM pointer switch")
    );

    state.handle(ClientId(1), ClientMsg::Undo);
    assert!(state.show_dm_cursor, "and the switch went back");
}

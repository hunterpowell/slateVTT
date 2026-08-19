//! The DM's undo ring.
//!
//! Two things here are worth reading before adding to it. **The ring is
//! post-state**, so its back is always the room as it stands and an undo pops
//! that to adopt what is behind it — which is why a fresh room has exactly one
//! entry and nothing to undo. And **`Restored` is the second message in this
//! project that hands over the whole world**, so the assertions that matter most
//! are the ones about what a *player* is handed by it.

use super::*;

/// Adds one step: a shape the DM drew, which persists and is cheap to assert on.
///
/// The receiver is drained rather than ignored, and that is not tidiness. The
/// test mailbox holds sixteen frames and `dispatch` drops a client whose mailbox
/// is full — so a test that issues a dozen commands without reading them loses
/// its DM partway through and every later `check` fails with "join the room
/// first" instead of the rule it meant to assert.
fn draw(state: &mut RoomState, by: ClientId, rx: &mut mpsc::Receiver<ServerMsg>) {
    state.handle(
        by,
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Point(Pos { x: 2.0, y: 2.0 }),
            to: Pos { x: 3.0, y: 0.0 },
            color: "#ff8c42e6".to_owned(),
        },
    );
    let _ = drain_all(rx);
}

fn undo(state: &mut RoomState, by: ClientId, rx: &mut mpsc::Receiver<ServerMsg>) {
    state.handle(by, ClientMsg::Undo);
    let _ = drain_all(rx);
}

/// Why a command was refused, so a test cannot pass because the client was
/// dropped rather than because the rule fired.
fn refusal(state: &RoomState, by: ClientId) -> String {
    state
        .check(by, &ClientMsg::Undo)
        .expect_err("undo should have been refused")
}

/// The label the DM's next undo would carry, read the way their client reads it.
fn label(state: &RoomState) -> Option<String> {
    state.snapshot_for(&Identity::Dm).undo
}

#[test]
fn a_fresh_room_has_nothing_to_undo() {
    // The seed entry is the room as it booted. It is the floor of the ring
    // rather than a step, which is the whole reason `undo_label` asks for two.
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    assert_eq!(label(&state), None);
    assert!(refusal(&state, dm).contains("nothing to undo"));

    state.handle(dm, ClientMsg::Undo);
    match drain_all(&mut dm_rx).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("nothing to undo")),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_label_names_the_command_it_would_take_back() {
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    draw(&mut state, dm, &mut dm_rx);
    assert_eq!(label(&state).as_deref(), Some("a drawing"));

    state.handle(dm, trace(&[(0.0, 0.0), (64.0, 0.0)], false));
    assert_eq!(
        label(&state).as_deref(),
        Some("tracing walls"),
        "the newest step is the one a press would take"
    );

    undo(&mut state, dm, &mut dm_rx);
    assert_eq!(
        label(&state).as_deref(),
        Some("a drawing"),
        "and afterwards the one before it"
    );
}

#[test]
fn undoing_a_map_load_gives_back_the_walls_the_shapes_and_the_fog_together() {
    // **The case that makes undo worth having.** `sweep_board` destroys three
    // subsystems in one command, so the inverse of it is most of a second state
    // model — and a snapshot restores all three for nothing. If this project
    // ever tries an inverse-per-command undo, this is the test that says why not.
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    state.handle(
        dm,
        fogged(set_map("/uploads/dungeon.png", 64.0, 0.0, 0.0), 60.0),
    );
    state.handle(dm, trace(&[(0.0, 0.0), (64.0, 0.0), (64.0, 64.0)], false));
    draw(&mut state, dm, &mut dm_rx);
    state.handle(
        dm,
        ClientMsg::SetFogOverride {
            cells: vec![(9, 9), (9, 10)],
            state: Some(Override::Dark),
            staged: false,
        },
    );

    let walls = state.walls.len();
    let shapes = state.shapes.len();
    let overrides = state.overrides.len();
    let revealed = state.revealed.len();
    assert!(walls > 0 && shapes > 0 && overrides > 0 && revealed > 0);

    // One command, and all four are gone.
    state.handle(dm, set_map("/uploads/somewhere-else.png", 64.0, 0.0, 0.0));
    assert!(state.walls.is_empty(), "the load swept the walls");
    assert!(state.shapes.is_empty(), "and the drawings");
    assert!(state.overrides.is_empty(), "and the paint");
    assert!(state.revealed.is_empty(), "and the party's memory");

    undo(&mut state, dm, &mut dm_rx);

    assert_eq!(state.map.url, "/uploads/dungeon.png");
    assert_eq!(state.walls.len(), walls, "the masonry came back");
    assert_eq!(state.shapes.len(), shapes, "and the drawings");
    assert_eq!(state.overrides.len(), overrides, "and the paint");
    assert_eq!(
        state.revealed.len(),
        revealed,
        "and where the party had been"
    );
    // Derived rather than restored — a `Saved` holds the memory and not the
    // sight — so this is the assertion that `adopt` is followed by a recompute.
    assert!(
        !state.visible.is_empty(),
        "and sight was rebuilt rather than left empty"
    );
}

#[test]
fn a_drag_is_one_step_and_not_thirty() {
    // `persists` already refuses a drag frame a disk write, and the ring reads
    // the same list rather than carrying a rule of its own. This is that
    // sharing asserted: without it a token dragged across the board would push
    // the whole ring out in one gesture.
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let id = TokenId::new("t6");

    let before = state.undo.len();
    for step in 1..=8 {
        state.handle(
            dm,
            ClientMsg::MoveToken {
                id: id.clone(),
                x: 10.0 + step as f32,
                y: 10.0,
                dragging: true,
                staged: false,
            },
        );
        let _ = drain_all(&mut dm_rx);
    }
    assert_eq!(state.undo.len(), before, "no drag frame is a step");

    state.handle(
        dm,
        ClientMsg::MoveToken {
            id,
            x: 18.0,
            y: 10.0,
            dragging: false,
            staged: false,
        },
    );
    assert_eq!(state.undo.len(), before + 1, "the drop is the one step");
    assert_eq!(label(&state).as_deref(), Some("moving a token"));
}

#[test]
fn the_ring_stops_at_its_depth_and_undo_is_not_itself_a_step() {
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    // Comfortably past the cap, so the oldest entries have fallen off.
    for _ in 0..MAX_UNDO + 5 {
        draw(&mut state, dm, &mut dm_rx);
    }
    assert_eq!(state.undo.len(), MAX_UNDO + 1, "the ring holds its depth");

    // Undoing does not push, or the ring would grow a new top every time the
    // DM walked back down it and the second press would return to where the
    // first started. Walking it to the floor is exactly `MAX_UNDO` presses.
    for _ in 0..MAX_UNDO {
        undo(&mut state, dm, &mut dm_rx);
    }
    assert_eq!(state.undo.len(), 1, "back to the floor");
    assert_eq!(label(&state), None, "and nothing left to take");
    assert!(refusal(&state, dm).contains("nothing to undo"));
}

#[test]
fn a_player_may_not_undo_and_is_never_sent_the_label() {
    // The negative assertion this project asks for, in both halves: the command
    // is refused, and the state a player holds never carries what the DM's
    // button says. `None` is also what an untouched room says, so a player
    // cannot tell the difference — the walls' rule, on a label.
    let mut state = room();
    let dm = ClientId(1);
    let player = ClientId(2);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut player_rx = join_as_player(&mut state, player, "saelyn");

    draw(&mut state, dm, &mut dm_rx);
    assert!(label(&state).is_some(), "the DM has something to take back");
    assert_eq!(
        state.snapshot_for(&as_player("saelyn")).undo,
        None,
        "and the player is told nothing about it"
    );

    // Not one `UndoChanged` in everything they have been sent, across a command
    // that certainly moved the ring.
    let frames = drain_all(&mut player_rx);
    assert!(
        !frames
            .iter()
            .any(|m| matches!(m, ServerMsg::UndoChanged { .. })),
        "a player was sent an undo label: {frames:?}"
    );

    assert!(refusal(&state, player).contains("only the DM"));
    state.handle(player, ClientMsg::Undo);
    match drain_all(&mut player_rx).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("only the DM")),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(
        label(&state).is_some(),
        "and the refused command left the ring alone"
    );
}

#[test]
fn the_dm_is_told_what_their_next_press_would_take_beside_every_change() {
    // The pairing `drain` hides from every other test in this suite, asserted
    // once here: a command that changes the room tells the DM what it did *and*
    // what undoing it would now mean. Without the second frame their button
    // would name the previous step until they reloaded.
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    state.handle(
        dm,
        ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::Point(Pos { x: 2.0, y: 2.0 }),
            to: Pos { x: 3.0, y: 0.0 },
            color: "#ff8c42e6".to_owned(),
        },
    );
    match drain_all(&mut dm_rx).as_slice() {
        [
            ServerMsg::ShapesChanged { .. },
            ServerMsg::UndoChanged { label },
        ] => {
            assert_eq!(label.as_deref(), Some("a drawing"));
        }
        other => panic!("expected the change and its label: {other:?}"),
    }
}

#[test]
fn a_restore_is_filtered_exactly_as_a_join_is() {
    // Invariant 3 on the second message that hands over the whole world. The
    // DM's masonry and their next map leave through the same door here as on
    // any join, because it is the same function — a `Restored` built any other
    // way is where this project would leak the dungeon.
    let mut state = room();
    let dm = ClientId(1);
    let player = ClientId(2);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut player_rx = join_as_player(&mut state, player, "saelyn");

    state.handle(dm, trace(&[(0.0, 0.0), (64.0, 0.0)], false));
    stage(&mut state, dm, "/uploads/next.png");
    draw(&mut state, dm, &mut dm_rx);
    let _ = drain_all(&mut player_rx);

    state.handle(dm, ClientMsg::Undo);

    // Both are sent one — the room changed under both of them.
    match drain_all(&mut dm_rx).as_slice() {
        [ServerMsg::Restored { state }, ServerMsg::UndoChanged { .. }] => {
            assert!(!state.walls.is_empty(), "the DM keeps their masonry");
            assert!(state.staged.is_some(), "and their next map");
        }
        other => panic!("the DM should have been restored: {other:?}"),
    }

    match drain_all(&mut player_rx).as_slice() {
        [ServerMsg::Restored { state }] => {
            assert!(state.walls.is_empty(), "a player is sent no walls");
            assert!(state.staged.is_none(), "and no next map");
            assert_eq!(state.undo, None, "and no label");
        }
        other => panic!("the player should have been restored, once: {other:?}"),
    }
}

#[test]
fn a_players_drawing_is_a_step_the_dm_can_take_back() {
    // The ring holds the persisted room rather than the DM's own commands, so a
    // shape a player drew is on it. That is deliberate and is what keeps undo
    // chronological: were a player's action not a step, an undo after one would
    // silently take their drawing *and* the DM's last command together.
    //
    // Milestone 24's scratchpads are the case that does not qualify — private
    // to their author, and restoring one from ten commands ago would eat a
    // paragraph with nothing on screen to say so. See `RoomState::undo`.
    let mut state = room();
    let dm = ClientId(1);
    let player = ClientId(2);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut player_rx = join_as_player(&mut state, player, "saelyn");

    state.handle(dm, trace(&[(0.0, 0.0), (64.0, 0.0)], false));
    draw(&mut state, player, &mut player_rx);
    assert_eq!(state.shapes.len(), 1);

    undo(&mut state, dm, &mut dm_rx);
    assert!(state.shapes.is_empty(), "the drawing went back");
    assert_eq!(
        state.walls.len(),
        1,
        "and only the drawing — the wall traced before it stayed"
    );
}

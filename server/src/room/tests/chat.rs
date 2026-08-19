//! Whisper and shout: two destinations, one log, and who is party to a line.
//! See `docs/chat.md`.
//!
//! Most of what is asserted here is a frame that never left. A whisper is the
//! first thing in this project withheld from one *player* and delivered to
//! another, so "and Torrin was sent nothing" is not a tidy extra assertion —
//! it is the feature.

use super::*;

fn say(to: ChatTo, text: &str) -> ClientMsg {
    ClientMsg::Say {
        to,
        text: text.to_owned(),
    }
}

fn shout(text: &str) -> ClientMsg {
    say(ChatTo::Table, text)
}

fn whisper_dm(text: &str) -> ClientMsg {
    say(ChatTo::Dm, text)
}

fn whisper(slot: &str, text: &str) -> ClientMsg {
    say(ChatTo::Player(PlayerId::new(slot)), text)
}

/// Every line one connection was actually sent, in order.
fn heard(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<String> {
    drain(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::Said { line } => Some(line.text),
            _ => None,
        })
        .collect()
}

/// The log as one identity is handed it on join. `heard`'s twin, and the pair
/// is the point: invariant 3 says the snapshot and the deltas have to agree,
/// and here they are two code paths over one rule.
fn log_for(state: &RoomState, who: &Identity) -> Vec<String> {
    state
        .snapshot_for(who)
        .chat
        .into_iter()
        .map(|line| line.text)
        .collect()
}

// --- shouting -------------------------------------------------------------

#[test]
fn a_shout_reaches_everyone_including_whoever_shouted() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(2), shout("18"));

    // The sender is echoed their own, which no other relayed frame in this
    // project does. A line of text is not predicted locally: where it lands in
    // the log is the room's to decide, and a client appending its own would
    // have two orderings to reconcile the first time two people typed at once.
    assert_eq!(heard(&mut saelyn), ["18"]);
    assert_eq!(heard(&mut dm), ["18"]);
    assert_eq!(heard(&mut torrin), ["18"]);
}

#[test]
fn a_shout_is_attributed_to_the_socket_and_not_to_the_frame() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout("we go left"));

    match drain(&mut dm).as_slice() {
        [ServerMsg::Said { line }] => {
            assert_eq!(line.by, Owner::Player(PlayerId::new("saelyn")));
            assert_eq!(line.to, ChatTo::Table);
        }
        other => panic!("expected one line, got {other:?}"),
    }
}

// --- whispering -----------------------------------------------------------

#[test]
fn a_whisper_to_the_dm_reaches_the_dm_and_the_sender_and_nobody_else() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(2), whisper_dm("i pick the lock"));

    assert_eq!(heard(&mut dm), ["i pick the lock"]);
    // The sender is one end of it, so they hold it too — otherwise the person
    // who said it is the one person who cannot see they said it.
    assert_eq!(heard(&mut saelyn), ["i pick the lock"]);
    // The whole assertion. Not an empty frame, not a redacted one: nothing.
    assert!(
        heard(&mut torrin).is_empty(),
        "a whisper reached a player who was not party to it"
    );
}

#[test]
fn the_dms_whisper_reaches_one_player_and_no_other() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(1), whisper("saelyn", "you hear breathing"));

    assert_eq!(heard(&mut saelyn), ["you hear breathing"]);
    assert_eq!(heard(&mut dm), ["you hear breathing"]);
    assert!(
        heard(&mut torrin).is_empty(),
        "the table was told what one player was whispered"
    );
}

#[test]
fn a_player_may_not_whisper_another_player() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(2), whisper("torrin", "psst"));

    // The boundary of the whole feature, and it is refused rather than
    // downgraded to a shout — a message that quietly goes somewhere else is
    // worse than one that bounces.
    match drain(&mut saelyn).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("whisper the DM")),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(heard(&mut torrin).is_empty(), "it was delivered anyway");
    assert!(state.chat.is_empty(), "a refused line is not in the log");
}

#[test]
fn the_dm_may_not_whisper_a_name_nobody_has() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), whisper("nobody", "hello?"));

    match drain(&mut dm).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("nobody by that name")),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_whisper_to_a_player_who_is_away_is_waiting_when_they_join() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));

    // Nobody is holding that slot yet. The room takes the line anyway: the log
    // is what a join is handed, so a whisper sent to somebody still making
    // coffee is not lost, and this needed no rule of its own.
    state.handle(ClientId(1), whisper("saelyn", "the door was ajar"));

    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    // Delivered by the `Welcome`, not by a delta — so nothing arrives here.
    assert!(heard(&mut saelyn).is_empty());
    assert_eq!(log_for(&state, &as_player("saelyn")), ["the door was ajar"]);
}

// --- the join snapshot ----------------------------------------------------

#[test]
fn the_log_a_join_is_handed_is_the_one_that_client_is_party_to() {
    // Invariant 3, on the first piece of state where getting it wrong hands
    // over somebody's words rather than a position. The deltas above and this
    // are two code paths over one rule, which is why both are asserted.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout("rolled a 4"));
    state.handle(ClientId(2), whisper_dm("can i see the ceiling?"));
    state.handle(ClientId(1), whisper("torrin", "you feel watched"));

    assert_eq!(
        log_for(&state, &Identity::Dm),
        ["rolled a 4", "can i see the ceiling?", "you feel watched"],
        "the DM is one end of every whisper, so they hold all of them"
    );
    assert_eq!(
        log_for(&state, &as_player("saelyn")),
        ["rolled a 4", "can i see the ceiling?"],
        "their own whisper and the shout, and nothing addressed to Torrin"
    );
    assert_eq!(
        log_for(&state, &as_player("torrin")),
        ["rolled a 4", "you feel watched"],
        "the shout and what they were whispered, and not Saelyn's question"
    );
    assert_eq!(
        log_for(&state, &as_player("ignacio")),
        ["rolled a 4"],
        "somebody at neither end of either whisper holds only the shout"
    );
}

// --- what the room does and does not keep ---------------------------------

#[test]
fn the_log_is_capped_and_trims_from_the_front() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    for n in 0..MAX_CHAT_LINES + 10 {
        state.handle(ClientId(2), shout(&n.to_string()));
        // Emptied every time round, because a test connection's mailbox holds
        // sixteen frames and a wedged client is dropped from the room — which
        // would make this a test of the mailbox rather than of the cap.
        let _ = drain_all(&mut saelyn);
    }

    assert_eq!(state.chat.len(), MAX_CHAT_LINES);
    assert_eq!(state.chat.front().map(|l| l.text.as_str()), Some("10"));
    assert_eq!(
        state.chat.back().map(|l| l.text.as_str()),
        Some((MAX_CHAT_LINES + 9).to_string().as_str())
    );
}

#[test]
fn nothing_said_is_worth_a_disk_write_or_a_step_on_the_ring() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let depth = state.undo.len();

    assert!(
        !state.handle(ClientId(2), shout("19")),
        "the log is session memory; it never marks the room dirty"
    );
    assert_eq!(
        state.undo.len(),
        depth,
        "and it is never a step to go back to"
    );
    // `drain_all` rather than `drain`: the point is that no `UndoChanged` rode
    // along, which the filtered version would hide.
    assert!(
        !drain_all(&mut dm)
            .iter()
            .any(|msg| matches!(msg, ServerMsg::UndoChanged { .. })),
        "the undo button was relabelled by somebody talking"
    );
}

#[test]
fn an_undo_does_not_take_back_what_the_table_said() {
    // Milestone 22 wrote the rule down — the ring may only hold state the
    // undoing hand wrote — and this is the first thing to test it. It passes by
    // construction: a snapshot is a `Saved`, and the log is not on one.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout("15"));
    state.handle(ClientId(1), ClientMsg::ClearShapes);
    let _ = drain_all(&mut dm);

    state.handle(ClientId(1), ClientMsg::Undo);

    assert_eq!(
        state.chat.len(),
        1,
        "an undo ate a line somebody else had typed"
    );
    // And the restored view still carries it, so the client that adopts that
    // view is not looking at a log the room has forgotten.
    assert_eq!(log_for(&state, &Identity::Dm), ["15"]);
}

#[test]
fn the_log_is_not_on_the_disk() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(2), whisper_dm("my passive perception is 16"));

    // Not a field to check for: session memory means the save format has no
    // opinion about it at all, so this asserts the whole shape of the file.
    let json = serde_json::to_string(&state.to_saved()).expect("a room serializes");
    assert!(
        !json.contains("passive perception"),
        "a whisper reached the save file"
    );
}

// --- what may be said -----------------------------------------------------

#[test]
fn nothing_and_whitespace_are_refused_and_a_line_is_stored_trimmed() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout("   "));
    match drain(&mut saelyn).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("nothing to say")),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(state.chat.is_empty());

    state.handle(ClientId(2), shout("  16  "));
    assert_eq!(state.chat.back().map(|l| l.text.as_str()), Some("16"));
}

#[test]
fn a_line_longer_than_the_cap_is_refused() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout(&"a".repeat(MAX_CHAT_LEN + 1)));

    match drain(&mut saelyn).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("longer than")),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(state.chat.is_empty());
}

#[test]
fn the_dm_cannot_whisper_themselves() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), whisper_dm("note to self"));

    match drain(&mut dm).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("you are the DM")),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

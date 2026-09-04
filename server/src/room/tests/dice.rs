//! The loaner die: a bag of plastic, thrown by the room, landing in the log.
//! See `docs/dice.md`.
//!
//! Two things are asserted here and they pull in opposite directions. One is
//! that the throw is *random* — a test that only checks the bounds passes
//! against a function returning 1 every time, so every face has to be seen to
//! land. The other is that a roll is *a line of talk*, which means the rest of
//! the interesting assertions are `chat.rs`'s: who was not sent it, and what
//! was not written down.

use super::*;

fn throw(sides: u8, count: u8, to: ChatTo) -> ClientMsg {
    ClientMsg::Roll { sides, count, to }
}

fn shout_roll(sides: u8, count: u8) -> ClientMsg {
    throw(sides, count, ChatTo::Table)
}

fn typed(text: &str) -> ClientMsg {
    ClientMsg::Say {
        to: ChatTo::Table,
        text: text.to_owned(),
    }
}

/// Every line one connection was actually sent, in order.
///
/// `chat.rs` has this too, and the duplication is deliberate: the two files
/// assert over the same frame, and hoisting four lines into `tests.rs` would
/// couple two suites that otherwise share nothing.
fn heard(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<String> {
    drain(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::Said { line } => Some(line.text),
            _ => None,
        })
        .collect()
}

/// The face values of every roll in the log, flattened.
///
/// Parsed back out of the text, which is the only place they exist — the room
/// keeps a sentence rather than a `Vec<u8>`, and that is the design rather than
/// a gap in it.
fn faces(state: &RoomState) -> Vec<u32> {
    state
        .chat
        .iter()
        .filter(|line| line.rolled)
        .flat_map(|line| {
            let (_, results) = line
                .text
                .split_once('\u{2192}')
                .expect("a roll says what it got");
            let results = results.split_once('(').map_or(results, |(dice, _)| dice);
            results
                .split(',')
                .map(|face| face.trim().parse().expect("a face is a number"))
                .collect::<Vec<u32>>()
        })
        .collect()
}

// --- where a throw lands --------------------------------------------------

#[test]
fn a_roll_reaches_everyone_including_whoever_threw_it() {
    // The echo is `Said`'s rule and this inherits it whole: a log is a sequence
    // and where a line falls in it is the room's to decide, so nothing about a
    // roll is predicted on the client that asked for it.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(2), shout_roll(20, 1));

    let thrown = heard(&mut saelyn);
    assert_eq!(thrown.len(), 1, "the thrower was not sent their own roll");
    assert_eq!(heard(&mut dm), thrown);
    assert_eq!(heard(&mut torrin), thrown);
}

#[test]
fn a_roll_whispered_to_the_dm_is_absent_from_every_other_player() {
    // The feature's whole claim over a physical die, and the assertion that
    // matters is the third one: Torrin was sent nothing.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(2), throw(20, 1, ChatTo::Dm));

    let thrown = heard(&mut saelyn);
    assert_eq!(thrown.len(), 1);
    assert_eq!(
        heard(&mut dm),
        thrown,
        "the DM was not party to a roll at them"
    );
    assert!(
        heard(&mut torrin).is_empty(),
        "a private roll reached a player it was not addressed to"
    );
    // And the snapshot agrees with the delta, which is invariant 3 on the one
    // state where getting it wrong hands over somebody else's dice.
    assert!(
        state
            .snapshot_for(&Identity::Player(PlayerId::new("torrin")))
            .chat
            .is_empty()
    );
}

#[test]
fn the_dm_may_roll_where_only_they_can_see_it() {
    // **The one place `Roll` diverges from `Say`.** A note to self is what the
    // scratchpad is for, so `Say` refuses this; a monster's save has nowhere
    // else to go, so `Roll` allows it. `party_to` needed no change — the DM
    // matches both halves of its `Dm` arm and gets exactly one copy.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(1), throw(20, 1, ChatTo::Dm));

    assert_eq!(
        heard(&mut dm).len(),
        1,
        "the DM's own secret roll never arrived"
    );
    assert!(
        heard(&mut saelyn).is_empty(),
        "a secret roll reached the table"
    );

    // The asymmetry is the point, so the other half of it is pinned here too:
    // widening `Roll` must not have widened `Say` underneath it.
    state.handle(
        ClientId(1),
        ClientMsg::Say {
            to: ChatTo::Dm,
            text: "note to self".to_owned(),
        },
    );
    match drain(&mut dm).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("you are the DM")),
        other => panic!("expected `Say` to still refuse the DM's own ear, got {other:?}"),
    }
}

#[test]
fn a_player_may_not_roll_at_another_player() {
    // The boundary the non-goal draws, asked of the second command that can
    // reach a `ChatTo`. `may_address` is one rule, and this is the proof that
    // `Roll` goes through it rather than around it.
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(
        ClientId(2),
        throw(20, 1, ChatTo::Player(PlayerId::new("torrin"))),
    );

    match drain(&mut saelyn).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("whisper the DM")),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(heard(&mut torrin).is_empty());
    assert!(state.chat.is_empty(), "a refused roll was logged anyway");
}

// --- what the dice actually do --------------------------------------------

#[test]
fn every_face_is_in_range_and_every_face_is_reachable() {
    // The second half is what stops the first passing against a function that
    // returns 1 forever. Each pass throws 200 handfuls of `MAX_DICE`, so 4,000
    // faces per die — a d20 misses a given face with probability (19/20)^4000,
    // which is not a number anybody will see. The RNG is the OS's and there is
    // no seed this test could fix, so that margin is its only defence.
    const THROWS: usize = 200;

    for sides in DICE_SIDES {
        let mut state = room();
        let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

        for _ in 0..THROWS {
            state.handle(ClientId(2), shout_roll(sides, MAX_DICE));
            // **Drained every time, and this test is a lie without it.** A
            // client's outbound mailbox is 16 deep and the room drops a client
            // whose mailbox fills — after which `apply` finds no sender, logs
            // nothing, and every later throw evaporates. This shipped without
            // the drain and measured *seventeen* throws while claiming four
            // thousand, which is a margin of one in twelve rather than one in
            // 10^17: it failed roughly one run in six and read as a biased RNG.
            let _ = drain(&mut saelyn);
        }

        let rolled = faces(&state);
        // The guard on the paragraph above. A sample that quietly shrinks turns
        // every assertion below into a coin toss, so its size is asserted
        // rather than assumed — the same reason `MAX_DICE` is not trusted to
        // relate to `MAX_CHAT_LEN` without a test measuring the sentence.
        assert_eq!(
            rolled.len(),
            THROWS * usize::from(MAX_DICE),
            "the sample is not the size this test's margin assumes"
        );
        assert!(
            rolled
                .iter()
                .all(|face| *face >= 1 && *face <= u32::from(sides)),
            "a d{sides} landed outside 1..={sides}"
        );
        // Every face for the small dice. A d100 would want far more throws than
        // the log holds, so it is asked of the two ends instead — which is
        // where a modulo bias or an off-by-one shows first anyway.
        if sides <= 20 {
            for face in 1..=u32::from(sides) {
                assert!(
                    rolled.contains(&face),
                    "a d{sides} never landed on {face} across {} throws",
                    rolled.len()
                );
            }
        } else {
            assert!(
                rolled.contains(&1),
                "a d{sides} never landed on 1 across {} throws",
                rolled.len()
            );
            assert!(
                rolled.contains(&u32::from(sides)),
                "a d{sides} never landed on {sides} across {} throws",
                rolled.len()
            );
        }
    }
}

#[test]
fn a_handful_says_what_each_die_did_and_what_they_come_to() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout_roll(6, 3));

    let line = state.chat.back().expect("a roll was logged");
    assert!(line.rolled, "a thrown line was not marked as thrown");
    assert!(
        line.text.starts_with("3d6 \u{2192} "),
        "got {:?}",
        line.text
    );

    let shown = faces(&state);
    assert_eq!(shown.len(), 3, "three dice did not report three faces");
    let total: u32 = shown.iter().sum();
    assert!(
        line.text.ends_with(&format!("({total})")),
        "the total disagreed with the dice printed above it: {:?}",
        line.text
    );

    // One die says so without a count and without a total, because there is
    // nothing there to add up.
    state.handle(ClientId(2), shout_roll(20, 1));
    let line = state.chat.back().expect("a roll was logged");
    assert!(
        line.text.starts_with("d20 \u{2192} "),
        "got {:?}",
        line.text
    );
    assert!(!line.text.contains('('), "one die reported a total");
}

#[test]
fn a_typed_line_is_not_marked_as_thrown() {
    // The flag's whole job: a witnessed number and a claimed one have to be
    // told apart, or the room doing the throwing bought nothing anybody can
    // see. Somebody typing the shape of a roll does not get the mark.
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), typed("d20 \u{2192} 20"));

    let line = state.chat.back().expect("a line was logged");
    assert!(
        !line.rolled,
        "a typed line claiming to be a roll was marked as one"
    );
}

// --- the two bounds -------------------------------------------------------

#[test]
fn a_die_that_is_not_in_the_bag_is_refused() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    for sides in [0, 1, 3, 7, 21, 255] {
        state.handle(ClientId(2), shout_roll(sides, 1));
        match drain(&mut saelyn).as_slice() {
            [ServerMsg::Error { message }] => {
                assert!(message.contains("not a die"), "got {message:?}")
            }
            other => panic!("a d{sides} was allowed: {other:?}"),
        }
    }
    assert!(state.chat.is_empty());
}

#[test]
fn no_dice_and_too_many_dice_are_both_refused() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout_roll(6, 0));
    match drain(&mut saelyn).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("no dice")),
        other => panic!("expected a refusal, got {other:?}"),
    }

    state.handle(ClientId(2), shout_roll(6, MAX_DICE + 1));
    match drain(&mut saelyn).as_slice() {
        [ServerMsg::Error { message }] => assert!(message.contains("more than")),
        other => panic!("expected a refusal, got {other:?}"),
    }

    assert!(state.chat.is_empty());
    // And the cap itself is allowed, or the bound is off by one in the
    // direction nobody notices until a fireball bounces.
    state.handle(ClientId(2), shout_roll(6, MAX_DICE));
    assert_eq!(state.chat.len(), 1);
}

#[test]
fn the_largest_roll_fits_a_chat_line() {
    // The two-bounds rule from `.claude/CLAUDE.md`, asked the way that file
    // says to ask it: build the largest legal instance and measure it, rather
    // than driving `check` and trusting the two numbers relate. `check` bounds
    // the dice; nothing bounds the sentence they produce except this.
    let widest = DICE_SIDES
        .iter()
        .copied()
        .max()
        .expect("the bag is not empty");
    let text = rolled_text(widest, &vec![widest; MAX_DICE as usize]);

    assert!(
        text.chars().count() <= MAX_CHAT_LEN,
        "the largest legal roll is {} characters against a cap of {MAX_CHAT_LEN}: {text:?}",
        text.chars().count()
    );
}

// --- what a roll is not ---------------------------------------------------

#[test]
fn nothing_thrown_is_worth_a_disk_write_or_a_step_on_the_ring() {
    // `chat.rs`'s test with dice in it, and it passes for the same reason: a
    // snapshot is a `Saved`, and the log is not on one. The ring is the sharper
    // half — an undo that could un-throw a die somebody is reading the number
    // off would be worse than useless.
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let depth = state.undo.len();

    assert!(
        !state.handle(ClientId(2), shout_roll(20, 1)),
        "a roll is session memory; it never marks the room dirty"
    );
    assert_eq!(state.undo.len(), depth, "a roll was a step to go back to");
    // `drain_all` rather than `drain`: the point is that no `UndoChanged` rode
    // along, which the filtered version would hide.
    assert!(
        !drain_all(&mut dm)
            .iter()
            .any(|msg| matches!(msg, ServerMsg::UndoChanged { .. })),
        "the undo button was relabelled by somebody throwing a die"
    );

    let json = serde_json::to_string(&state.to_saved()).expect("a room serializes");
    assert!(!json.contains('\u{2192}'), "a roll reached the save file");
}

#[test]
fn an_undo_does_not_take_back_a_throw() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    state.handle(ClientId(2), shout_roll(20, 1));
    let thrown = state.chat.back().expect("a roll was logged").text.clone();
    state.handle(ClientId(1), ClientMsg::ClearShapes);
    let _ = drain_all(&mut dm);

    state.handle(ClientId(1), ClientMsg::Undo);

    assert_eq!(state.chat.len(), 1, "an undo ate a die somebody threw");
    assert_eq!(state.chat.back().map(|l| l.text.clone()), Some(thrown));
}

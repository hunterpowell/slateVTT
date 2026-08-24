//! The scratchpad: one box of text per person, private to whoever wrote it.
//! See `docs/notes.md`.
//!
//! **Every assertion that matters here is about a frame that never left, and
//! for the first time in this suite one of them is a frame the DM never got.**
//! Every other filter in the project withholds downward; this one has no
//! `is_dm` in it at all, so "and the DM was sent nothing" is not a tidy extra
//! line — it is the feature, and a scratchpad the DM's client can open is a
//! surveillance feature wearing the same name.

use super::*;

fn write(text: &str) -> ClientMsg {
    ClientMsg::SetNotes {
        text: text.to_owned(),
    }
}

/// Every scratchpad frame one connection was actually sent, in order.
fn told(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<String> {
    drain(rx)
        .into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::NotesChanged { text } => Some(text),
            _ => None,
        })
        .collect()
}

/// The box one identity is handed on join. `told`'s twin, and the pair is the
/// point: invariant 3 says the snapshot and the deltas have to agree, and the
/// snapshot is where handing over the whole table's private notes would be one
/// forgotten line away.
fn box_for(state: &RoomState, who: &Identity) -> String {
    state.snapshot_for(who).notes
}

fn nothing() -> Vec<String> {
    Vec::new()
}

// --- who is told ----------------------------------------------------------

#[test]
fn a_scratchpad_reaches_its_author_and_nobody_else() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let mut saelyn_second_tab = join_as_player(&mut state, ClientId(3), "saelyn");
    let mut torrin = join_as_player(&mut state, ClientId(4), "torrin");

    state.handle(ClientId(2), write("the door on the left was warm"));

    // The socket that typed it is not told, which is `Pinged`'s exclusion and
    // not `Said`'s: the text is already in that box, and writing it back a round
    // trip later moves the caret out from under somebody mid-sentence.
    assert_eq!(told(&mut saelyn), nothing());
    // Their other tab is the whole audience this event has, and the whole reason
    // it is an event rather than nothing at all.
    assert_eq!(
        told(&mut saelyn_second_tab),
        ["the door on the left was warm"]
    );
    // The two that matter. Neither is a filter being generous in the wrong
    // direction — the DM is not a supervisor here, they are somebody with a box
    // of their own.
    assert_eq!(told(&mut torrin), nothing());
    assert_eq!(told(&mut dm), nothing());
}

#[test]
fn the_dms_scratchpad_is_no_different_from_anybody_elses() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut dm_second_tab = join_as_dm(&mut state, ClientId(2));
    let mut saelyn = join_as_player(&mut state, ClientId(3), "saelyn");

    state.handle(ClientId(1), write("the innkeeper is lying"));

    assert_eq!(told(&mut dm), nothing());
    assert_eq!(told(&mut dm_second_tab), ["the innkeeper is lying"]);
    assert_eq!(
        told(&mut saelyn),
        nothing(),
        "the table is not told the DM wrote something, let alone what"
    );
}

#[test]
fn a_join_is_handed_its_own_box_and_no_other() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let _torrin = join_as_player(&mut state, ClientId(3), "torrin");

    state.handle(ClientId(1), write("ambush in the second chamber"));
    state.handle(ClientId(2), write("ask about the sigil"));

    assert_eq!(
        box_for(&state, &Identity::Dm),
        "ambush in the second chamber"
    );
    assert_eq!(box_for(&state, &as_player("saelyn")), "ask about the sigil");
    // Invariant 3 with the same teeth `chat_for` has: filtering the deltas
    // correctly and forgetting this would hand a joining client somebody else's
    // paragraph in the one frame nobody looks at twice.
    assert_eq!(box_for(&state, &as_player("torrin")), "");
}

#[test]
fn an_empty_box_leaves_nothing_behind() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    state.handle(ClientId(1), write("scratch this"));
    let _ = drain(&mut saelyn);
    state.handle(ClientId(1), write(""));

    assert_eq!(box_for(&state, &as_player("saelyn")), "");
    // `Auto`'s rule from the fog overrides: one representation of "there is
    // nothing here", so a cleared box costs the save file nothing and somebody
    // who never opened this is not in it at all.
    assert!(
        !state
            .notes
            .contains_key(&Owner::Player(PlayerId::new("saelyn"))),
        "a cleared box is a missing entry, not an empty string"
    );
}

// --- what may be written --------------------------------------------------

#[test]
fn anybody_may_write_in_their_own_box() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    // No `require_dm`, and no per-item rule underneath it either. The command
    // names no box, so the only one it can reach is the sender's — which is the
    // permission this feature has instead of a check.
    assert!(state.check(ClientId(1), &write("mine")).is_ok());
}

#[test]
fn a_scratchpad_longer_than_the_cap_is_refused() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    let too_much = "x".repeat(MAX_NOTES_LEN + 1);
    let refusal = state
        .check(ClientId(1), &write(&too_much))
        .expect_err("over the cap");
    assert!(refusal.contains(&MAX_NOTES_LEN.to_string()));

    // And the boundary itself is fine, which is what makes the client's
    // `maxlength` and this the same number rather than two nearly-equal ones.
    let exactly = "x".repeat(MAX_NOTES_LEN);
    assert!(state.check(ClientId(1), &write(&exactly)).is_ok());
}

// --- the undo ring --------------------------------------------------------

#[test]
fn writing_in_a_scratchpad_is_never_a_step() {
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);

    state.handle(dm, ClientMsg::SetShowNames { show: false });
    let _ = drain_all(&mut dm_rx);
    state.handle(dm, write("not a step"));
    let _ = drain_all(&mut dm_rx);

    // The ring did not gain a top, so the DM's button still names the thing they
    // actually did to the room.
    assert_eq!(
        state.snapshot_for(&Identity::Dm).undo.as_deref(),
        Some("the name switch")
    );
}

#[test]
fn an_undo_does_not_take_back_what_somebody_typed() {
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    // A command, then a paragraph written after it, then a second command. The
    // paragraph is on the snapshot the second command pushed — which is exactly
    // how a scratchpad gets eaten by a button somebody else is holding.
    state.handle(dm, ClientMsg::SetShowNames { show: false });
    let _ = drain_all(&mut dm_rx);
    state.handle(ClientId(2), write("the door on the left was warm"));
    let _ = drain(&mut saelyn);
    state.handle(
        dm,
        ClientMsg::SetDiagonals {
            diagonals: Diagonals::Alternating,
        },
    );
    let _ = drain_all(&mut dm_rx);

    state.handle(dm, ClientMsg::Undo);
    let _ = drain_all(&mut dm_rx);

    // The room went back and the box did not. Milestone 22's rule is that the
    // ring may hold state the undoing hand wrote, and this is the case it was
    // written for.
    assert_eq!(state.diagonals, Diagonals::Equal);
    assert_eq!(
        box_for(&state, &as_player("saelyn")),
        "the door on the left was warm"
    );
    // And nothing told them it had been near a thing that could eat it. A
    // restore re-sends the world; their box is not part of that world.
    assert_eq!(told(&mut saelyn), nothing());
}

#[test]
fn undoing_past_a_scratchpad_that_did_not_exist_yet_still_leaves_it_alone() {
    let mut state = room();
    let dm = ClientId(1);
    let mut dm_rx = join_as_dm(&mut state, dm);
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    // Every snapshot on the ring predates this paragraph, so a restore that
    // adopted notes at all would blank it rather than stale it — the same bug
    // with nothing on screen to say so.
    state.handle(dm, ClientMsg::SetShowNames { show: false });
    let _ = drain_all(&mut dm_rx);
    state.handle(ClientId(2), write("written after every snapshot"));

    state.handle(dm, ClientMsg::Undo);
    let _ = drain_all(&mut dm_rx);

    assert_eq!(
        box_for(&state, &as_player("saelyn")),
        "written after every snapshot"
    );
}

// --- the disk -------------------------------------------------------------

#[test]
fn a_scratchpad_is_worth_writing_down() {
    let mut state = room();
    let mut saelyn = join_as_player(&mut state, ClientId(1), "saelyn");

    // `Said`'s opposite: the room keeps this *and* writes it down, because
    // surviving a restart is most of what it is worth over the Notepad window
    // everybody already has open.
    assert!(
        state.handle(ClientId(1), write("ask about the sigil")),
        "a scratchpad should mark the room dirty"
    );
    let _ = drain(&mut saelyn);

    let reloaded = reboot(state.to_saved());
    assert_eq!(
        box_for(&reloaded, &as_player("saelyn")),
        "ask about the sigil"
    );
    // And it comes back to its author alone, which is the half of this a boot
    // could quietly get wrong: `adopt` reads a list of pairs, and a form that
    // lost the key would hand one box to whoever asked first.
    assert_eq!(box_for(&reloaded, &Identity::Dm), "");
}

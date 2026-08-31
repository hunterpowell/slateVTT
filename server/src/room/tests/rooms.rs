//! More than one room on one server: the table that defines them, and the
//! isolation between two rooms' casts.
//!
//! What is *not* here, deliberately, is a test that room A's tokens never reach
//! a room B client. There is nothing to assert: a room is a `tokio` task that
//! exclusively owns its `RoomState`, and two rooms share no field, no channel
//! and no lock, so a leak between them is not a filter that could be written
//! wrong — it is a reference that does not exist. What *can* go wrong is one
//! room's identity being accepted by another, which is what the second half of
//! this file is about. `tools/drive-rooms.mjs` asks the board question of two
//! real browsers.

use super::*;

// --- the room table -----------------------------------------------------

#[test]
fn every_room_id_is_a_slug() {
    // An id is joined onto a directory to make a save file, put in a URL as
    // `?room=`, and used as a `localStorage` key. A slash or a dot in one is a
    // path; a space in one is a link that needs escaping.
    for (id, _) in rooms() {
        assert!(!id.is_empty(), "a room id must be something");
        assert!(
            id.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "{id} is not a slug"
        );
    }
}

#[test]
fn room_ids_are_unique() {
    // `main.rs` builds a `HashMap` off these, so a duplicate would not be an
    // error — it would silently be one room fewer, with the second definition's
    // roster on the first one's save file.
    let mut seen = Vec::new();
    for (id, _) in rooms() {
        assert!(!seen.contains(&id), "{id} is defined twice");
        seen.push(id);
    }
}

#[test]
fn exactly_one_room_is_primary() {
    // Two things hang off this and both are answers to "which room did the
    // single-room server become": whose save file is `SLATE_STATE` verbatim,
    // and who boots the built-in board. Two primaries would fight over the
    // first; none would leave the campaign's save file unread.
    assert_eq!(rooms().filter(|(id, _)| is_primary(id)).count(), 1);
}

#[test]
fn every_room_has_a_cast() {
    // `main.rs` panics rather than spawning a room with no roster, which would
    // be a room no player could ever join.
    for (id, _) in rooms() {
        let roster = roster_of(id).unwrap_or_else(|| panic!("{id} has no roster"));
        assert!(!roster.is_empty(), "{id} has an empty roster");
    }
}

#[test]
fn every_roster_id_is_a_slug() {
    // The same rule as `every_room_id_is_a_slug` above, one level down, and it
    // is the rule `.claude/CLAUDE.md` states about a roster slot: the id is what
    // `localStorage` remembers, what a token's `owner` is written as, and what
    // keys this player's colour and their scratchpad. So renaming one after a
    // room has been played in orphans four things at once, and a slot id with a
    // space in it is a name wearing an id's job. The display name beside it is
    // free text and is deliberately not checked.
    for (id, _) in rooms() {
        let roster = roster_of(id).unwrap_or_else(|| panic!("{id} has no roster"));
        for entry in roster {
            let slug = &entry.id.0;
            assert!(!slug.is_empty(), "a roster id in {id} must be something");
            assert!(
                slug.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{slug} in {id} is not a slug"
            );
        }
    }
}

// --- one room's cast is not another's ------------------------------------

/// A room with the Halloween cast rather than the campaign's, so that the two
/// rosters can be told apart. Empty rather than `hardcoded` for the same reason
/// the real one is: the built-in board's tokens are the campaign's party.
fn other_room() -> RoomState {
    RoomState::blank(SECRET.to_owned(), roster_from(&HALLOWEEN_ROSTER))
}

#[test]
fn a_slug_from_another_rooms_roster_is_not_an_identity() {
    // The isolation guarantee at identity level, and the reason a player in two
    // campaigns holds two slugs. `hello` accepts a `player_id` only if it names
    // a slot in *this* room's roster, so a stale `localStorage` value — or a
    // hand-typed one — falls back to the picker rather than becoming a person
    // nobody at this table is.
    let mut state = other_room();
    let mut rx = connect(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new("cleodara")),
        },
    );

    match rx.try_recv().expect("a reply") {
        ServerMsg::ChooseIdentity { roster } => {
            assert_eq!(roster.len(), HALLOWEEN_ROSTER.len());
            assert!(
                roster
                    .iter()
                    .all(|slot| slot.id != PlayerId::new("cleodara")),
                "the campaign's cast must not be offered in the one-shot"
            );
        }
        other => panic!("expected ChooseIdentity, got {other:?}"),
    }
    assert!(
        state.clients.is_empty(),
        "a slug from another room must not admit anyone"
    );
}

#[test]
fn a_slug_from_this_rooms_roster_still_admits() {
    // The other half, so the test above is not passing because `hello` refuses
    // everybody.
    let mut state = other_room();
    let mut rx = connect(&mut state, ClientId(1));
    let (slug, _) = HALLOWEEN_ROSTER[0];

    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new(slug)),
        },
    );

    match rx.try_recv().expect("a reply") {
        ServerMsg::Welcome { player_id, .. } => {
            assert_eq!(player_id, Some(PlayerId::new(slug)));
        }
        other => panic!("expected Welcome, got {other:?}"),
    }
}

#[test]
fn the_dm_secret_opens_a_room_whatever_its_cast_is() {
    // One secret for the process, which is the decision `docs/rooms.md` records
    // against `ROADMAP.md`'s per-room one. The DM is the same person in both
    // rooms and holds no slot in either.
    let mut state = other_room();
    let mut rx = connect(&mut state, ClientId(1));

    state.handle(
        ClientId(1),
        ClientMsg::Hello {
            dm_secret: Some(SECRET.to_owned()),
            player_id: None,
        },
    );

    match rx.try_recv().expect("a reply") {
        ServerMsg::Welcome { is_dm, .. } => assert!(is_dm),
        other => panic!("expected Welcome, got {other:?}"),
    }
}

#[test]
fn a_new_room_starts_with_an_empty_board() {
    // What `blank` is for. A one-shot seeded with the campaign's six party
    // members is the "stashing old tokens" this feature exists to avoid, one
    // room over.
    let state = other_room();
    assert!(state.tokens.is_empty(), "a new room has nothing on it");
    assert!(state.walls.is_empty());
    assert!(state.shapes.is_empty());
    assert!(state.initiative.entries.is_empty());
    // The board it stands on is the built-in placeholder rather than nothing.
    // `MapInfo::default` has no URL, and a client handed one loads no image,
    // builds no stage and draws nothing — a new room would open black. See
    // `blank`.
    assert_eq!(state.map.url, BUILT_IN_MAP);
    assert!(!state.map.fog, "and nothing on it is hidden yet");
}

#[test]
fn a_new_rooms_first_command_is_undoable() {
    // `blank` ends in `floor` like both its neighbours. Without it the first
    // thing the DM does in a fresh room becomes the bottom of the ring and
    // cannot be taken back — see `docs/undo.md`.
    let mut state = other_room();
    let dm = ClientId(1);
    let _rx = join_as_dm(&mut state, dm);

    state.handle(
        dm,
        ClientMsg::SetShowNames {
            show: !state.show_names,
        },
    );

    assert!(
        state.undo_label().is_some(),
        "the first command in a new room must be undoable"
    );
}

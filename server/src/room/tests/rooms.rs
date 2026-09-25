//! More than one room on one server: the table that defines them, and the
//! isolation between two rooms' casts.
//!
//! There is no test here that room A's tokens never reach a room B client,
//! because there is nothing to assert: a room is a `tokio` task that
//! exclusively owns its `RoomState`, and two rooms share no field, channel or
//! lock. A leak between them would need a reference that doesn't exist, not a
//! filter written wrong. What can go wrong is one room's identity being
//! accepted by another, which is what the second half of this file is about.
//! `tools/drive-rooms.mjs` asks the board question of two real browsers.

use super::*;

// --- the room table -----------------------------------------------------

/// Every site `ROOMS` names, in the order they first appear.
fn sites() -> Vec<&'static str> {
    let mut sites = Vec::new();
    for def in &ROOMS {
        if !sites.contains(&def.site) {
            sites.push(def.site);
        }
    }
    sites
}

#[test]
fn every_room_id_is_a_slug() {
    // An id is joined onto a directory to make a save file, put in a URL as
    // `?room=`, and used as a `localStorage` key. A slash or a dot in one is a
    // path; a space in one is a link that needs escaping.
    for def in &ROOMS {
        assert!(is_slug(def.id), "{} is not a slug", def.id);
    }
}

#[test]
fn room_ids_are_unique() {
    // `main.rs` builds a `HashMap` off these, so a duplicate would not be an
    // error: it would silently be one room fewer, with the second definition's
    // roster on the first one's save file. Unique across sites, not only
    // within one, so a room id alone says which room is meant.
    let mut seen = Vec::new();
    for def in &ROOMS {
        assert!(!seen.contains(&def.id), "{} is defined twice", def.id);
        seen.push(def.id);
    }
}

#[test]
fn every_site_has_exactly_one_primary_room() {
    // Whose save file is `SLATE_STATE` verbatim, in each process. Two
    // primaries on one site would fight over that file; none would leave it
    // unread.
    for site in sites() {
        assert_eq!(
            rooms(site).filter(|(id, _)| is_primary(id)).count(),
            1,
            "{site}"
        );
    }
}

#[test]
fn only_the_campaign_boots_into_the_built_in_board() {
    // Its tokens are the campaign's party. Another site's first room seeded
    // with them would open on somebody else's characters.
    let demos: Vec<&str> = ROOMS
        .iter()
        .map(|def| def.id)
        .filter(|id| boots_demo(id))
        .collect();
    assert_eq!(demos, vec!["campaign"]);
}

#[test]
fn a_site_serves_its_own_rooms_and_nobody_elses() {
    // The whole reason for a site: the second site's process must not list, spawn or
    // accept a socket for the campaign or the one-shot, and the Pi's first
    // process has no reason to hold his room.
    let home: Vec<&str> = rooms(DEFAULT_SITE).map(|(id, _)| id).collect();
    assert_eq!(home, vec!["campaign", "halloween"]);
    let second: Vec<&str> = rooms("sword-legend").map(|(id, _)| id).collect();
    assert_eq!(second, vec!["sword-legend"]);
    // A mistyped `SLATE_SITE`, which `main.rs` refuses to boot.
    assert_eq!(rooms("sword-legnd").count(), 0);
}

#[test]
fn every_seed_roster_id_is_a_slug() {
    // The rule `roster_allowed` holds the DM's edits to, applied to what the
    // code seeds a room with: the id is what `localStorage` remembers, what a
    // token's `owner` is written as, and what keys this player's colour and
    // their scratchpad. The display name beside it is free text.
    for def in &ROOMS {
        let roster = roster_of(def.id).unwrap_or_else(|| panic!("{} has no roster", def.id));
        assert!(roster.len() <= MAX_ROSTER, "{}", def.id);
        for entry in roster {
            let slug = &entry.id.0;
            assert!(
                is_slug(slug) && slug.len() <= MAX_PLAYER_ID_LEN,
                "{slug} in {} is not a slug",
                def.id
            );
        }
    }
}

// --- one room's cast is not another's ------------------------------------

/// A room with the Halloween cast instead of the campaign's, so that the two
/// rosters can be told apart. Empty, not `hardcoded`, for the same reason the
/// real one is: the built-in board's tokens are the campaign's party.
fn other_room() -> RoomState {
    RoomState::blank(SECRET.to_owned(), roster_from(&HALLOWEEN_ROSTER))
}

#[test]
fn a_slug_from_another_rooms_roster_is_not_an_identity() {
    // The isolation guarantee at identity level, and the reason a player in two
    // campaigns holds two slugs. `hello` accepts a `player_id` only if it names
    // a slot in this room's roster, so a stale `localStorage` value (or a
    // hand-typed one) falls back to the picker instead of becoming a person
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
    // The board it stands on is the built-in placeholder, not nothing.
    // `MapInfo::default` has no URL, and a client handed one loads no image,
    // builds no stage and draws nothing: a new room would open black. See
    // `blank`.
    assert_eq!(state.map.url, BUILT_IN_MAP);
    assert!(!state.map.fog, "and nothing on it is hidden yet");
}

#[test]
fn a_new_rooms_first_command_is_undoable() {
    // `blank` ends in `floor` like both its neighbours. Without it the first
    // thing the DM does in a fresh room becomes the bottom of the ring and
    // can't be taken back. See `docs/undo.md`.
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

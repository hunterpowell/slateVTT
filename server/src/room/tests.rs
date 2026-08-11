//! Tests for the room actor, split along the same seams as `docs/`.
//!
//! These are child modules of `room` rather than a sibling integration test
//! for one reason: they drive `RoomState` through its *private* surface —
//! `pending`, `hardcoded`, `handle` — which is the only way to assert what a
//! given client was and was not sent. An integration test could only watch
//! the wire, and half of what is interesting here is a message that never
//! left.
//!
//! Everything below is shared by more than one section; a helper only one
//! section uses lives in that section's own file. Each of those opens with
//! `use super::*`, which picks these up along with the room's own items.

use super::*;
// Only the tests name these; `check` and `apply` reach a `Rect` through the
// `Option` on the message, and a `Px` through the `Vec` on a traced run.
use crate::protocol::{Px, Rect};

const SECRET: &str = "test-secret";

fn room() -> RoomState {
    RoomState::hardcoded(SECRET.to_owned())
}

/// Opens a connection and returns its outbound receiver.
fn connect(state: &mut RoomState, client: ClientId) -> mpsc::Receiver<ServerMsg> {
    let (tx, rx) = mpsc::channel(16);
    state.pending.insert(client, tx);
    rx
}

fn join_as_player(
    state: &mut RoomState,
    client: ClientId,
    slot: &str,
) -> mpsc::Receiver<ServerMsg> {
    let mut rx = connect(state, client);
    state.handle(
        client,
        ClientMsg::Hello {
            dm_secret: None,
            player_id: Some(PlayerId::new(slot)),
        },
    );
    rx.try_recv().expect("welcome");
    rx
}

fn join_as_dm(state: &mut RoomState, client: ClientId) -> mpsc::Receiver<ServerMsg> {
    let mut rx = connect(state, client);
    state.handle(
        client,
        ClientMsg::Hello {
            dm_secret: Some(SECRET.to_owned()),
            player_id: None,
        },
    );
    rx.try_recv().expect("welcome");
    rx
}

fn create(name: &str, size: f32, owner: Owner) -> ClientMsg {
    ClientMsg::CreateToken {
        name: name.to_owned(),
        img: String::new(),
        size,
        owner,
        x: 6.3,
        y: 5.1,
        hidden: false,
        hp: None,
        staged: false,
    }
}

/// The same command with the token already out of sight of the table.
fn create_hidden(name: &str) -> ClientMsg {
    with(create(name, 1.0, Owner::Dm), |hidden, _| *hidden = true)
}

/// Flips one or both of the two flags on a `CreateToken`, so the helpers
/// above stay one line each and a field added later does not have to be
/// restated in any of them.
fn with(msg: ClientMsg, set: impl FnOnce(&mut bool, &mut bool)) -> ClientMsg {
    let ClientMsg::CreateToken {
        mut hidden,
        mut staged,
        name,
        img,
        size,
        owner,
        x,
        y,
        hp,
    } = msg
    else {
        return msg;
    };
    set(&mut hidden, &mut staged);
    ClientMsg::CreateToken {
        name,
        img,
        size,
        owner,
        x,
        y,
        hidden,
        hp,
        staged,
    }
}

/// An edit that leaves a token exactly as it is. Tests change one field off
/// this rather than restating all seven, so a field added later does not
/// silently reset itself everywhere.
fn edit(token: &Token) -> ClientMsg {
    ClientMsg::UpdateToken {
        id: token.id.clone(),
        name: token.name.clone(),
        img: token.img.clone(),
        size: token.size,
        owner: token.owner.clone(),
        hidden: token.hidden,
        hp: token.hp,
    }
}

/// That edit with `hidden` flipped to `want`.
fn set_hidden(token: &Token, want: bool) -> ClientMsg {
    match edit(token) {
        ClientMsg::UpdateToken {
            id,
            name,
            img,
            size,
            owner,
            hp,
            ..
        } => ClientMsg::UpdateToken {
            id,
            name,
            img,
            size,
            owner,
            hidden: want,
            hp,
        },
        other => other,
    }
}

fn token(state: &RoomState, id: &str) -> Token {
    state
        .tokens
        .get(&TokenId::new(id))
        .unwrap_or_else(|| panic!("no token {id}"))
        .clone()
}

/// The token the DM just made, found by name because the id is the server's.
///
/// Names must therefore be unique within a test, and must not collide with
/// the built-in room's — `HashMap` order is unspecified, so a duplicate
/// name is a test that passes or fails depending on the run.
fn made(state: &RoomState, name: &str) -> Token {
    let mut found = state.tokens.values().filter(|t| t.name == name);
    let token = found
        .next()
        .unwrap_or_else(|| panic!("no token called {name}"))
        .clone();
    assert!(
        found.next().is_none(),
        "two tokens called {name}; this test cannot tell them apart"
    );
    token
}

fn as_player(slot: &str) -> Identity {
    Identity::Player(PlayerId::new(slot))
}

/// Every frame waiting on a connection. `try_recv` one at a time makes a
/// test that says "and nothing else" hard to write and easy to get wrong.
fn drain(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<ServerMsg> {
    let mut frames = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        frames.push(msg);
    }
    frames
}

fn names(view: &RoomView) -> Vec<&str> {
    view.tokens.iter().map(|t| t.name.as_str()).collect()
}

fn order(init: &Initiative) -> Vec<&str> {
    init.entries.iter().map(|e| e.token.0.as_str()).collect()
}

fn current(init: &Initiative) -> Option<&str> {
    init.current.as_ref().map(|t| t.0.as_str())
}

/// Fog off and a default radius, on every map helper below. A test that wants
/// the lights out says so with `fogged`, so nothing here has to think about
/// sight — which is also what the DM's experience of an unfogged map is.
const UNFOGGED: (bool, f32) = (false, 60.0);

fn set_map(url: &str, grid_px: f32, offset_x: f32, offset_y: f32) -> ClientMsg {
    ClientMsg::SetMap {
        url: url.to_owned(),
        grid_px,
        offset_x,
        offset_y,
        grid_color: "#ffffff52".to_owned(),
        play_area: None,
        fog: UNFOGGED.0,
        vision_ft: UNFOGGED.1,
        staged: false,
    }
}

/// The same command with the lights out. Every map helper here builds an
/// unfogged `set_map`; this is how a fog test asks for the other kind,
/// exactly as `staged` is how one asks for the other slot.
fn fogged(msg: ClientMsg, vision_ft: f32) -> ClientMsg {
    match msg {
        ClientMsg::SetMap { url, grid_px, .. } => ClientMsg::SetMap {
            url,
            grid_px,
            offset_x: 0.0,
            offset_y: 0.0,
            grid_color: "#ffffff52".to_owned(),
            play_area: None,
            fog: true,
            vision_ft,
            staged: false,
        },
        other => other,
    }
}

/// The same command aimed at the staged slot. Every map helper here builds a
/// live `set_map`; this is how a test asks for the staged one, so the two
/// slots are always exercised with identical commands.
fn staged(msg: ClientMsg) -> ClientMsg {
    match msg {
        ClientMsg::SetMap {
            url,
            grid_px,
            offset_x,
            offset_y,
            grid_color,
            play_area,
            fog,
            vision_ft,
            staged: _,
        } => ClientMsg::SetMap {
            url,
            grid_px,
            offset_x,
            offset_y,
            grid_color,
            play_area,
            fog,
            vision_ft,
            staged: true,
        },
        other => other,
    }
}

fn rect(x: f32, y: f32, w: f32, h: f32) -> Option<Rect> {
    Some(Rect { x, y, w, h })
}

/// Stages a map and drains the DM's echo, leaving the receiver empty so a
/// test can assert on what arrives next.
fn stage(state: &mut RoomState, dm: ClientId, url: &str) {
    state.handle(dm, staged(set_map(url, 80.0, 0.0, 0.0)));
}

/// One traced run, in image pixels. The corners are on a 64 px lattice
/// because that is what the client's corner snap produces on the default
/// grid, not because anything on the server cares.
fn trace(points: &[(f32, f32)], door: bool) -> ClientMsg {
    ClientMsg::AddWalls {
        points: points.iter().map(|&(x, y)| Px { x, y }).collect(),
        door,
    }
}

/// A room with the lights out: one player token at cell (1,1), one monster
/// at cell (5,1), and nothing else on the board.
///
/// The hardcoded room is five party members and two monsters spread across
/// it, which is a fine board and a poor experiment — every one of those five
/// is a torch, so almost everything is lit from almost everywhere. These
/// tests want one viewer and one thing to look at.
///
/// The grid is the default 64 pixels at no offset, so cell `(c, r)` has its
/// centre at `(64c + 32, 64r + 32)` and a wall drawn at x = 256 stands
/// between columns 3 and 4.
fn fog_room(vision_ft: f32) -> RoomState {
    let mut state = room();
    state.tokens.clear();
    state.initiative = Initiative::default();

    for (id, name, x, owner) in [
        ("p", "Saelyn", 1.5, Owner::Player(PlayerId::new("saelyn"))),
        ("m", "Ogre", 5.5, Owner::Dm),
    ] {
        state.tokens.insert(
            TokenId::new(id),
            Token {
                id: TokenId::new(id),
                name: name.to_owned(),
                x,
                y: 1.5,
                owner,
                ..Token::default()
            },
        );
    }

    state.map.fog = true;
    state.map.vision_ft = vision_ft;
    state.recompute_sight();
    state
}

/// A single traced segment, as the DM's editor would send it.
fn wall(x1: f32, y1: f32, x2: f32, y2: f32, door: bool) -> ClientMsg {
    ClientMsg::AddWalls {
        points: vec![Px { x: x1, y: y1 }, Px { x: x2, y: y2 }],
        door,
    }
}

/// A wall standing between the viewer and the monster in `fog_room`.
fn between(door: bool) -> ClientMsg {
    wall(256.0, 0.0, 256.0, 256.0, door)
}

/// Walks the viewer along row 1 and settles it there, as a drop would.
/// Sent by `ClientId(1)`, so every caller has to have joined as the DM.
fn walk(state: &mut RoomState, x: f32) {
    state.handle(
        ClientId(1),
        ClientMsg::MoveToken {
            id: TokenId::new("p"),
            x,
            y: 1.5,
            dragging: false,
            staged: false,
        },
    );
}

/// What the DM's brush and their fill both send. The cells are the payload —
/// the fill is computed on their client, where the preview needs it anyway.
fn paint(cells: &[Cell], state: Option<Override>) -> ClientMsg {
    ClientMsg::SetFogOverride {
        cells: cells.to_vec(),
        state,
    }
}

mod drawings;
mod fog_of_war;
mod handshake;
mod initiative;
mod maps;
mod movement;
mod persistence;
mod tokens;
mod walls;

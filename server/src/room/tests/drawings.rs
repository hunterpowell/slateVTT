//! Shapes on the board, and which of them a recipient is told about.
//! See `docs/drawings.md`.

use super::*;

const INK: &str = "#ff8c42e6";

fn add_shape(kind: ShapeKind, from: Origin, to: (f32, f32)) -> ClientMsg {
    ClientMsg::AddShape {
        kind,
        from,
        to: Pos { x: to.0, y: to.1 },
        color: INK.to_owned(),
    }
}

/// An unanchored circle, which is the ordinary case.
fn circle_at(x: f32, y: f32) -> ClientMsg {
    add_shape(ShapeKind::Circle, Origin::Point(Pos { x, y }), (4.0, 0.0))
}

fn sketch(at: (f32, f32), drawing: bool) -> ClientMsg {
    ClientMsg::Sketch {
        kind: ShapeKind::Line,
        at: Pos { x: at.0, y: at.1 },
        to: Pos { x: 3.0, y: 4.0 },
        color: INK.to_owned(),
        drawing,
    }
}

/// The shapes as one recipient is actually sent them.
fn shapes_seen(state: &RoomState, who: &Identity) -> Vec<ShapeId> {
    state
        .snapshot_for(who)
        .shapes
        .into_iter()
        .map(|s| s.id)
        .collect()
}

fn only_shape(state: &RoomState) -> Shape {
    match state.shapes.as_slice() {
        [shape] => shape.clone(),
        other => panic!("expected exactly one shape, found {}", other.len()),
    }
}

// --- drawings -------------------------------------------------------------

#[test]
fn anyone_may_draw_and_the_server_names_the_shape() {
    // The first thing a player may add to the room. No `require_dm` on the
    // way in, unlike every other command that creates something.
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    assert!(state.handle(ClientId(2), circle_at(3.0, 4.0)));

    let shape = only_shape(&state);
    assert!(!shape.id.0.is_empty(), "the server invents the id");
    assert_eq!(shape.by, Owner::Player(PlayerId::new("saelyn")));
    assert_eq!(shape.kind, ShapeKind::Circle);
    assert_eq!(shape.anchor(), None);
}

#[test]
fn a_player_may_erase_their_own_drawing_and_not_someone_elses() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    let _cleodara = join_as_player(&mut state, ClientId(3), "cleodara");

    state.handle(ClientId(2), circle_at(3.0, 4.0));
    let id = only_shape(&state).id;

    assert_eq!(
        state.check(ClientId(3), &ClientMsg::RemoveShape { id: id.clone() }),
        Err("that is not yours to erase".to_owned()),
        "cleodara did not draw it"
    );
    // The DM may erase anything, and so may whoever drew it.
    assert!(
        state
            .check(ClientId(1), &ClientMsg::RemoveShape { id: id.clone() })
            .is_ok()
    );
    assert!(
        state
            .check(ClientId(2), &ClientMsg::RemoveShape { id: id.clone() })
            .is_ok()
    );

    state.handle(ClientId(2), ClientMsg::RemoveShape { id });
    assert!(state.shapes.is_empty());
}

#[test]
fn only_the_dm_may_sweep_the_board() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(2), circle_at(3.0, 4.0));

    assert_eq!(
        state.check(ClientId(2), &ClientMsg::ClearShapes),
        Err("only the DM can clear the board".to_owned())
    );
    assert_eq!(state.shapes.len(), 1, "and nothing was cleared");
}

#[test]
fn an_aura_on_a_hidden_monster_is_not_on_the_tables_board() {
    // The leak this milestone had to close early. The roadmap files anchor
    // visibility under fog of war, but `hidden` exists now, and a shape that
    // follows a token is that token's position drawn in colour.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), create_hidden("Ambusher"));
    let ambusher = made(&state, "Ambusher").id;

    state.handle(
        ClientId(1),
        add_shape(
            ShapeKind::Circle,
            Origin::Token(ambusher.clone()),
            (2.0, 0.0),
        ),
    );

    assert_eq!(shapes_seen(&state, &as_player("saelyn")), Vec::new());
    assert_eq!(shapes_seen(&state, &Identity::Dm).len(), 1);

    // And not merely absent from the list — the id must not be in the bytes
    // at all, which is how invariant 4 has to be checked.
    let json = serde_json::to_string(&state.snapshot_for(&as_player("saelyn"))).expect("encodes");
    assert!(!json.contains(&ambusher.0));
}

#[test]
fn revealing_a_monster_brings_what_is_drawn_on_it_along() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), create_hidden("Ambusher"));
    let monster = made(&state, "Ambusher");

    state.handle(
        ClientId(1),
        add_shape(
            ShapeKind::Circle,
            Origin::Token(monster.id.clone()),
            (2.0, 0.0),
        ),
    );
    drain(&mut saelyn);

    state.handle(ClientId(1), set_hidden(&monster, false));

    let frames = drain(&mut saelyn);
    let shapes = frames.iter().find_map(|f| match f {
        ServerMsg::ShapesChanged { shapes } => Some(shapes),
        _ => None,
    });
    assert_eq!(
        shapes.map(Vec::len),
        Some(1),
        "the aura arrives with the monster"
    );

    // And hiding it again takes it back off their board.
    let monster = made(&state, "Ambusher");
    state.handle(ClientId(1), set_hidden(&monster, true));
    assert_eq!(shapes_seen(&state, &as_player("saelyn")), Vec::new());
}

#[test]
fn hiding_a_token_nothing_is_drawn_on_says_nothing_about_shapes() {
    // The gate that keeps this from becoming an announcement. A player who
    // is sent a `ShapesChanged` every time the DM hides something learns
    // that the DM hid something, which is the thing being withheld.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), circle_at(3.0, 4.0));
    let ogre = token(&state, "t6");
    drain(&mut saelyn);

    state.handle(ClientId(1), set_hidden(&ogre, true));

    assert!(
        !drain(&mut saelyn)
            .iter()
            .any(|f| matches!(f, ServerMsg::ShapesChanged { .. })),
        "nothing was anchored to the ogre"
    );
}

#[test]
fn a_player_cannot_anchor_to_a_token_they_cannot_see() {
    // Refused in the same words a token that does not exist is refused. Two
    // different answers here would turn this into an oracle: sweep the id
    // space, and the refusals map out the DM's monsters.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), create_hidden("Ambusher"));
    let hidden = made(&state, "Ambusher").id;

    let refusal = state.check(
        ClientId(2),
        &add_shape(ShapeKind::Circle, Origin::Token(hidden.clone()), (2.0, 0.0)),
    );
    assert_eq!(refusal, Err(format!("no such token: {}", hidden.0)));
    assert_eq!(
        state.check(
            ClientId(2),
            &add_shape(
                ShapeKind::Circle,
                Origin::Token(TokenId::new("nonsense")),
                (2.0, 0.0)
            ),
        ),
        Err("no such token: nonsense".to_owned()),
        "and a token nobody has is refused identically"
    );

    // The DM may anchor to it: it is their monster and their board.
    assert!(
        state
            .check(
                ClientId(1),
                &add_shape(ShapeKind::Circle, Origin::Token(hidden), (2.0, 0.0))
            )
            .is_ok()
    );
}

#[test]
fn a_player_cannot_erase_a_drawing_they_are_not_sent() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(1), create_hidden("Ambusher"));
    let monster = made(&state, "Ambusher").id;
    state.handle(
        ClientId(1),
        add_shape(ShapeKind::Circle, Origin::Token(monster), (2.0, 0.0)),
    );
    let id = only_shape(&state).id;

    assert_eq!(
        state.check(ClientId(2), &ClientMsg::RemoveShape { id }),
        Err("that drawing is already gone".to_owned()),
        "and not 'not yours', which would confirm it exists"
    );
}

#[test]
fn deleting_a_token_takes_what_is_drawn_on_it() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let ogre = token(&state, "t6");

    state.handle(
        ClientId(1),
        add_shape(
            ShapeKind::Circle,
            Origin::Token(ogre.id.clone()),
            (2.0, 0.0),
        ),
    );
    // One that follows nothing, to prove the sweep is not indiscriminate.
    state.handle(ClientId(1), circle_at(20.0, 20.0));

    state.handle(ClientId(1), ClientMsg::DeleteToken { id: ogre.id });

    assert_eq!(state.shapes.len(), 1);
    assert_eq!(only_shape(&state).anchor(), None);
}

#[test]
fn a_new_map_clears_the_drawings_and_a_recalibration_does_not() {
    // The same split the plans for the next room turn on, and the same arm
    // that gets missed: a shape describes cells on this board, so a new
    // image throws it away and correcting the grid must not.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), circle_at(3.0, 4.0));

    state.handle(ClientId(1), set_map("/assets/map.png", 80.0, 3.0, 4.0));
    assert_eq!(state.shapes.len(), 1, "recalibrating the map on the board");

    state.handle(ClientId(1), set_map("/uploads/cave.webp", 70.0, 0.0, 0.0));
    assert!(state.shapes.is_empty(), "a different dungeon");
}

#[test]
fn staging_and_promoting_leave_the_board_swept() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), circle_at(3.0, 4.0));

    // Staging a map is not a change to the board, and shapes belong to the
    // board. Nothing is drawn on the map being prepared, so nothing goes.
    stage(&mut state, ClientId(1), "/uploads/next.webp");
    assert_eq!(state.shapes.len(), 1);

    // Promoting is a new map arriving, which is where they go.
    state.handle(ClientId(1), ClientMsg::PromoteStaged);
    assert!(state.shapes.is_empty());
}

#[test]
fn a_sketch_reaches_everyone_but_the_client_sweeping_it() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let mut saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut dm);
    drain(&mut saelyn);

    state.handle(ClientId(2), sketch((1.0, 1.0), true));

    assert!(matches!(
        drain(&mut dm).as_slice(),
        [ServerMsg::Sketch { by, .. }] if *by == ClientId(2)
    ));
    assert!(
        drain(&mut saelyn).is_empty(),
        "the sweeper draws it from their own pointer"
    );

    state.handle(ClientId(2), sketch((1.0, 1.0), false));
    assert!(matches!(
        drain(&mut dm).as_slice(),
        [ServerMsg::SketchEnded { by }] if *by == ClientId(2)
    ));
}

#[test]
fn a_sketch_is_never_stored_and_never_saved() {
    // The whole of what makes a measuring line free: it is not in the room,
    // so there is nothing to filter, nothing to snapshot, nothing to write.
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    assert!(!state.handle(ClientId(2), sketch((1.0, 1.0), true)));
    assert!(!state.handle(ClientId(2), sketch((2.0, 2.0), false)));
    assert!(state.shapes.is_empty());
    assert!(state.snapshot_for(&Identity::Dm).shapes.is_empty());
}

#[test]
fn a_client_that_vanishes_mid_sweep_does_not_strand_its_line() {
    let mut state = room();
    let mut dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");
    state.handle(ClientId(2), sketch((1.0, 1.0), true));
    drain(&mut dm);

    // What `RoomCmd::Disconnected` does, without the task around it.
    state.clients.remove(&ClientId(2));
    state.dispatch(ClientId(2), &[Event::SketchEnded { by: ClientId(2) }]);

    assert!(matches!(
        drain(&mut dm).as_slice(),
        [ServerMsg::SketchEnded { by }] if *by == ClientId(2)
    ));
}

#[test]
fn a_shape_cannot_be_stretched_across_the_world() {
    // Bounded because every client walks the cells an area covers. An absurd
    // one is a frozen browser on five other machines, and the sketch reaches
    // them before anybody has decided to keep it.
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    let huge = ClientMsg::Sketch {
        kind: ShapeKind::Circle,
        at: Pos { x: 0.0, y: 0.0 },
        to: Pos { x: 9_000.0, y: 0.0 },
        color: INK.to_owned(),
        drawing: true,
    };
    assert!(state.check(ClientId(2), &huge).is_err());
    assert!(
        state
            .check(
                ClientId(2),
                &add_shape(ShapeKind::Circle, Origin::default(), (9_000.0, 0.0))
            )
            .is_err(),
        "and keeping one is bounded the same way"
    );
}

#[test]
fn a_drawing_needs_a_colour_the_client_could_actually_use() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    for bad in ["", "red", "#ff8c42", "#ff8c42e6ff"] {
        let msg = ClientMsg::AddShape {
            kind: ShapeKind::Circle,
            from: Origin::default(),
            to: Pos { x: 2.0, y: 0.0 },
            color: bad.to_owned(),
        };
        assert_eq!(
            state.check(ClientId(2), &msg),
            Err("a shape colour must look like #rrggbbaa".to_owned()),
            "{bad:?} is not a colour"
        );
    }
}

#[test]
fn a_board_cannot_be_filled_with_drawings_without_limit() {
    let mut state = room();
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    // `apply` rather than `handle`, like the token cap above and for the
    // same reason: the rule under test is in `check`, and running sixty-four
    // of these through the whole pipeline only fills this test's outbound
    // mailbox and gets the drawer dropped as a wedged client.
    for _ in 0..MAX_SHAPES {
        state.apply(ClientId(2), circle_at(3.0, 4.0));
    }
    assert_eq!(state.shapes.len(), MAX_SHAPES);
    assert!(state.check(ClientId(2), &circle_at(3.0, 4.0)).is_err());
}

#[test]
fn a_drawing_survives_the_save_file() {
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    let ogre = token(&state, "t6");
    state.handle(
        ClientId(1),
        add_shape(ShapeKind::Cone, Origin::Token(ogre.id.clone()), (3.0, 3.0)),
    );

    let json = serde_json::to_vec(&state.to_saved()).expect("encodes");
    let saved: Saved = serde_json::from_slice(&json).expect("decodes");
    let restored = RoomState::restored(saved, SECRET.to_owned());

    let shape = only_shape(&restored);
    assert_eq!(shape.kind, ShapeKind::Cone);
    assert_eq!(shape.anchor(), Some(&ogre.id));
    assert_eq!((shape.to.x, shape.to.y), (3.0, 3.0));
}

#[test]
fn a_room_saved_before_drawings_existed_still_loads() {
    // Invariant 2, checked on the field this milestone added rather than
    // trusted: an older save carries no `shapes` at all.
    let saved: Saved = serde_json::from_str("{}").expect("an empty room decodes");
    let restored = RoomState::restored(saved, SECRET.to_owned());
    assert!(restored.shapes.is_empty());
}

// --- fog and the drawings on the board ----------------------------------

#[test]
fn a_drawing_on_ground_the_party_has_never_seen_is_withheld() {
    // 16a left this: an unanchored shape was sent to everyone, so a marker the
    // DM dropped on an unexplored room drew straight over the table's fog.
    let mut state = fog_room(10.0);
    let _dm = join_as_dm(&mut state, ClientId(1));

    state.handle(ClientId(1), circle_at(20.5, 20.5));

    assert_eq!(shapes_seen(&state, &as_player("saelyn")).len(), 0);
    assert_eq!(
        shapes_seen(&state, &Identity::Dm).len(),
        1,
        "their own annotation is still on their own board"
    );
}

#[test]
fn a_drawing_on_explored_ground_stays_after_the_party_walks_away() {
    // Gated on `revealed` and not on `visible`, which is the call this half of
    // the milestone turned on: a shape is painted on the floor rather than
    // standing on it, so it belongs with the terrain. Gating on current sight
    // would take a player's own marker away as they left the room, and make
    // every drawing on the board flicker as the party moved.
    let mut state = fog_room(20.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    let _saelyn = join_as_player(&mut state, ClientId(2), "saelyn");

    // Drawn on ground they are standing next to, then walked away from.
    state.handle(ClientId(2), circle_at(1.5, 1.5));
    assert_eq!(shapes_seen(&state, &as_player("saelyn")).len(), 1);

    walk(&mut state, 20.5);
    assert!(
        !state.visible.contains(&(1, 1)),
        "out of sight of where they drew it"
    );
    assert_eq!(
        shapes_seen(&state, &as_player("saelyn")).len(),
        1,
        "and it is still their marker on ground they remember"
    );
}

#[test]
fn turning_the_fog_off_does_not_take_every_drawing_with_it() {
    // The guard in `shape_seen`, and it is load-bearing rather than defensive:
    // `revealed` is empty on an unfogged map, so without it every loose shape
    // in the room would vanish from every player's board the moment the switch
    // was flipped.
    let mut state = room();
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), circle_at(50.5, 50.5));

    assert!(!state.map.fog, "lights on");
    assert_eq!(
        shapes_seen(&state, &as_player("saelyn")).len(),
        1,
        "a board with no fog withholds nothing"
    );
}

#[test]
fn the_fog_opening_onto_a_drawing_rebuilds_the_shape_list() {
    // The second reading `Sight` had to grow. Every *anchored* shape moves
    // with a token, so the token loop was enough to gate `ShapesChanged` on;
    // an unanchored one gates on `revealed`, which the party can change by
    // walking somewhere with no token of the DM's involved.
    let mut state = fog_room(20.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), circle_at(20.5, 1.5));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    assert_eq!(shapes_seen(&state, &as_player("saelyn")).len(), 0);
    drain(&mut rx);

    walk(&mut state, 20.5);

    let frames = drain(&mut rx);
    assert!(
        frames
            .iter()
            .any(|m| matches!(m, ServerMsg::ShapesChanged { shapes } if shapes.len() == 1)),
        "expected the drawing to arrive as they reached it, got {frames:?}"
    );
}

#[test]
fn nobody_is_told_about_a_drawing_that_was_visible_all_along() {
    // The same gate as everywhere else in this file, for the fourth time: an
    // unconditional `ShapesChanged` on every step would tell the table that
    // *something happened* every time anybody moved.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), circle_at(1.5, 1.5));
    let mut rx = join_as_player(&mut state, ClientId(2), "saelyn");
    drain(&mut rx);

    walk(&mut state, 2.5);

    let frames = drain(&mut rx);
    assert!(
        !frames
            .iter()
            .any(|m| matches!(m, ServerMsg::ShapesChanged { .. })),
        "nothing about the shapes changed, got {frames:?}"
    );
}

#[test]
fn a_blacked_out_room_takes_the_drawings_in_it_too() {
    // Falls out of the two halves rather than being a rule of its own: `Dark`
    // subtracts from `known`, and a loose shape gates on `known`.
    let mut state = fog_room(60.0);
    let _dm = join_as_dm(&mut state, ClientId(1));
    state.handle(ClientId(1), circle_at(1.5, 1.5));
    assert_eq!(shapes_seen(&state, &as_player("saelyn")).len(), 1);

    // The whole footprint of a radius-four circle centred on (1,1).
    let footprint: Vec<Cell> = (-4..=6)
        .flat_map(|x| (-4..=6).map(move |y| (x, y)))
        .collect();
    state.handle(ClientId(1), paint(&footprint, Some(Override::Dark)));

    assert_eq!(shapes_seen(&state, &as_player("saelyn")).len(), 0);
}

//! The room's snapshot on disk.
//!
//! One JSON file, rewritten whole. There is no database and no migration step:
//! invariant 2 puts `#[serde(default)]` on every persisted container, so a file
//! written by an older build still loads against a newer schema, and a field
//! this build has never heard of is ignored rather than fatal.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::fog::{FogView, OverrideView};
use crate::protocol::{
    Calibration, Diagonals, Initiative, MapInfo, Shape, StagedView, Token, Wall,
};

/// What actually goes to disk.
///
/// Deliberately neither `RoomView` nor `RoomState`. Not `RoomView`, because that
/// is the world as one particular client may see it and fog of war will make
/// those differ — the file must hold everything. Not `RoomState`, because the DM
/// secret comes from the environment and connected clients die with the process.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    pub map: MapInfo,
    /// The map the DM is preparing, with the walls and overrides they have
    /// prepared on it. Persisted, but never part of a player's view — the second
    /// thing here the whole room holds and one client's copy of it does not,
    /// after `calibrations`.
    ///
    /// It is saved for the reason the calibration table is: Slate runs only
    /// while the group is playing, so a map staged at the end of one evening
    /// for the next would otherwise be gone before it was ever wanted — and a
    /// dungeon traced on a Tuesday for the Saturday is the whole of milestone 20.
    ///
    /// The map inside it is flattened, so a file written when this was an
    /// `Option<MapInfo>` still loads its staged map. See `StagedView`.
    pub staged: Option<StagedView>,
    /// A list rather than a map keyed by id: the id already lives inside each
    /// token, and the room rebuilds its `HashMap` on load.
    pub tokens: Vec<Token>,
    pub initiative: Initiative,
    /// Drawn shapes, in draw order. Already a `Vec` in the room, so unlike the
    /// tokens there is nothing to sort on the way out.
    ///
    /// Persisted for the reason staging is: Slate runs only while the group is
    /// playing, so an area the DM places while prepping would otherwise be gone
    /// before the party arrived. Sketches are not here and never will be — one
    /// lasts as long as a mouse is held down.
    pub shapes: Vec<Shape>,
    /// Traced walls and doors, in image pixels. The third thing here the whole
    /// room holds and no player's copy of it does, after `calibrations` and
    /// `staged`.
    ///
    /// Tracing a dungeon is half an hour of work and it belongs to a map that
    /// will still be on the board next week, so this is the one thing on `Saved`
    /// that would make the feature unusable if it were not persisted.
    pub walls: Vec<Wall>,
    /// Everywhere the party has explored, packed the way the wire packs it.
    ///
    /// Only half the fog is here, and the half that is not is the interesting
    /// one: `visible` is derived from where the tokens are standing and what
    /// blocks sight between them, both of which this file already holds, so it is
    /// recomputed on boot rather than restored. A stored one could only disagree
    /// with the room it was stored beside — a door shut after the last save would
    /// describe sight straight through it.
    ///
    /// Reusing `FogView` rather than a list of cell pairs is the same bargain the
    /// wire makes: a few thousand characters laid out as a map instead of a few
    /// thousand numbers. The file happens to record every explored cell as `o`,
    /// since it is packed against an empty `visible`, and `fog::unpack` reads both
    /// lit states the same way so neither side has to know that.
    pub revealed: FogView,
    /// The DM's manual overrides, packed in their own alphabet — `#` forced dark,
    /// `o` forced explored, `*` forced in sight.
    ///
    /// The mirror image of the field above it. That one is half a derived thing
    /// and records only the half that cannot be recomputed; this one is not
    /// derived at all — it is what somebody decided, and no amount of walls and
    /// tokens would give it back. It is the walls' neighbour on this file rather
    /// than the fog's.
    pub overrides: OverrideView,
    /// Whether the board writes each token's name under it. Room-wide, and the
    /// DM's to set.
    ///
    /// **The one field here that carries a default of its own**, because the
    /// container's is wrong for it. Every other field falls back to
    /// `Saved::default()`, where a bool is `false` — so a file written before
    /// this existed would load with every name gone from the board, which is a
    /// change nobody asked for. `MapInfo::grid_px` is the same trap and `fog`
    /// defaulting off is the same argument pointing the other way: the safe
    /// default is whatever the room was already doing.
    #[serde(default = "shown")]
    pub show_names: bool,
    /// How the movement ruler charges a diagonal. Room-wide, and the DM's to set.
    ///
    /// `show_names`' neighbour that does *not* need a default of its own, and the
    /// reason is worth keeping beside the note above: `Diagonals::Equal` is what
    /// the ruler did before this field existed, so the container's default and
    /// "whatever the room was already doing" are the same value here. That is not
    /// luck — the variants were ordered to make it true.
    pub diagonals: Diagonals,
    /// Remembered grid calibrations, keyed by map URL.
    ///
    /// The first thing here that is not part of any client's view of the room.
    /// It is persisted because Slate only runs while the group is playing — an
    /// in-memory table would be empty at the start of every session, which is
    /// exactly when re-picking last week's map wants to find one.
    ///
    /// It grows by an entry per distinct map ever set and is never pruned. At a
    /// hundred bytes an entry that is not worth a cap; a DM would have to load
    /// tens of thousands of maps before this rivalled a single token image.
    pub calibrations: HashMap<String, Calibration>,
}

/// The default for `Saved::show_names`. Serde wants a function rather than a
/// literal, and this is the only place on this file that needs one.
fn shown() -> bool {
    true
}

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    /// The file exists but is not a room. Given the defaults above this is never
    /// a schema change, so it means the file is damaged or is not ours.
    Json(serde_json::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "{err}"),
            Self::Json(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for StoreError {}

pub struct Store {
    path: PathBuf,
    /// Written first, then renamed over `path`. A crash or a full disk partway
    /// through a write lands here and leaves the last good save untouched.
    tmp: PathBuf,
}

impl Store {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        // Appended to the whole path rather than swapping the extension, so it
        // cannot collide with the save itself whatever the path looks like.
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        Self {
            path,
            tmp: PathBuf::from(tmp),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `Ok(None)` means there is no save yet — a first boot, not a failure.
    /// Anything else is an error the caller must not paper over: starting a
    /// fresh room on top of an unreadable one destroys it with the next write.
    pub async fn load(&self) -> Result<Option<Saved>, StoreError> {
        let bytes = match fs::read(&self.path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(StoreError::Io(err)),
        };

        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(StoreError::Json)
    }

    pub async fn save(&self, saved: &Saved) -> Result<(), StoreError> {
        // Pretty-printed for the same reason the wire format is JSON: reading
        // the room in an editor is worth more than the bytes it costs.
        let json = serde_json::to_vec_pretty(saved).map_err(StoreError::Json)?;

        // `parent` of a bare filename is `Some("")`, which is not a directory.
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).await.map_err(StoreError::Io)?;
        }

        fs::write(&self.tmp, &json).await.map_err(StoreError::Io)?;
        fs::rename(&self.tmp, &self.path)
            .await
            .map_err(StoreError::Io)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;
    use crate::fog::Override;
    use crate::protocol::{
        Hp, InitiativeEntry, Lighting, Origin, Owner, PlayerId, Pos, Px, Rect, ShapeId, ShapeKind,
        TokenId, WallId, WallKind,
    };

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn unique(prefix: &str) -> PathBuf {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
    }

    /// A path under the OS temp dir, cleaned up when it drops — a leftover file
    /// would make the next run of these tests pass for the wrong reason.
    struct TempFile(PathBuf);

    impl TempFile {
        fn new() -> Self {
            Self(unique("slate-test.json"))
        }

        fn store(&self) -> Store {
            Store::new(self.0.clone())
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let store = self.store();
            let _ = std::fs::remove_file(&store.path);
            let _ = std::fs::remove_file(&store.tmp);
        }
    }

    fn a_room() -> Saved {
        Saved {
            map: MapInfo {
                url: "/assets/map.png".to_owned(),
                grid_px: 70.0,
                offset_x: 3.0,
                offset_y: -4.0,
                grid_color: "#33ff9980".to_owned(),
                play_area: Some(Rect {
                    x: 70.0,
                    y: 140.0,
                    w: 700.0,
                    h: 490.0,
                }),
                fog: true,
                vision_ft: 45.0,
                // Room, which is not the default, for the reason `show_names`
                // below is off: a field that only ever round-trips its own
                // default proves nothing about the round trip.
                lighting: Lighting::Room,
            },
            staged: Some(StagedView {
                map: MapInfo {
                    url: "/uploads/next-week.jpg".to_owned(),
                    grid_px: 96.0,
                    ..MapInfo::default()
                },
                // Traced on the Tuesday for the Saturday, which is the whole of
                // why the staged slot holds these at all.
                walls: vec![Wall {
                    id: WallId("w1".to_owned()),
                    from: Px { x: 0.0, y: 0.0 },
                    to: Px { x: 96.0, y: 0.0 },
                    kind: WallKind::Door(false),
                }],
                ..StagedView::default()
            }),
            tokens: vec![Token {
                id: TokenId::new("t1"),
                name: "Cleodara".to_owned(),
                x: 3.5,
                y: 12.5,
                owner: Owner::Player(PlayerId::new("cleodara")),
                img: "/assets/tokens/cleodara.png".to_owned(),
                // Odd, so the position above is a cell centre the snapping rule
                // would actually produce for a token this wide.
                size: 3.0,
                hidden: true,
                hp: Some(Hp {
                    current: 14,
                    max: 31,
                }),
                // Where the DM means this one to land when the map staged above
                // becomes the board.
                staged_pos: Some(Pos { x: 8.5, y: 2.5 }),
                staged_only: false,
            }],
            initiative: Initiative {
                entries: vec![InitiativeEntry {
                    token: TokenId::new("t1"),
                    value: 18,
                }],
                current: Some(TokenId::new("t1")),
                round: 4,
            },
            // One anchored to the token above, since that is the shape with a
            // reference in it and so the one a round trip could break.
            shapes: vec![Shape {
                id: ShapeId("s1".to_owned()),
                kind: ShapeKind::Circle,
                from: Origin::Token(TokenId::new("t1")),
                to: Pos { x: 4.0, y: 0.0 },
                by: Owner::Player(PlayerId::new("cleodara")),
                color: "#ff8c42e6".to_owned(),
            }],
            // One of each kind, since the door is the one that carries state
            // inside its tag and so the one a round trip could flatten.
            walls: vec![
                Wall {
                    id: WallId("w1".to_owned()),
                    from: Px { x: 64.0, y: 64.0 },
                    to: Px { x: 64.0, y: 320.0 },
                    kind: WallKind::Solid,
                },
                Wall {
                    id: WallId("w2".to_owned()),
                    from: Px { x: 64.0, y: 320.0 },
                    to: Px { x: 64.0, y: 384.0 },
                    kind: WallKind::Door(true),
                },
            ],
            // A ragged shape rather than a filled rectangle, since the packing is
            // row-major and a solid block would survive a transposed one.
            revealed: crate::fog::pack(
                &std::collections::HashSet::from([(2, 1), (3, 1), (4, 1), (4, 2), (-1, -1)]),
                &std::collections::HashSet::new(),
            ),
            // All three states, and one of them outside the explored box above:
            // the two rectangles are bounded independently, and packing them
            // against each other's bounds is the mistake this catches.
            overrides: crate::fog::pack_overrides(&HashMap::from([
                ((3, 1), Override::Dark),
                ((9, 9), Override::Lit),
                ((9, 10), Override::Explored),
            ])),
            // Off, which is not the default — a field that only ever round-trips
            // its own default proves nothing about the round trip.
            show_names: false,
            // Alternating, for the same reason and it is the same trap: `Equal`
            // is what a missing field decodes to, so a round trip that lost this
            // one entirely would pass.
            diagonals: Diagonals::Alternating,
            calibrations: HashMap::from([(
                "/uploads/digital-goblin-camp-1a2b3c4d.jpg".to_owned(),
                Calibration {
                    grid_px: 82.0,
                    offset_x: 11.0,
                    offset_y: -6.0,
                    grid_color: "#00ff00ff".to_owned(),
                    play_area: None,
                    fog: true,
                    vision_ft: 30.0,
                    lighting: Lighting::Room,
                },
            )]),
        }
    }

    #[tokio::test]
    async fn a_room_survives_the_round_trip() {
        let file = TempFile::new();
        let store = file.store();

        store.save(&a_room()).await.expect("saved");
        let loaded = store.load().await.expect("loads").expect("a room");

        assert_eq!(loaded.map.grid_px, 70.0);
        assert_eq!((loaded.map.offset_x, loaded.map.offset_y), (3.0, -4.0));
        assert_eq!(loaded.map.grid_color, "#33ff9980");
        assert_eq!(
            loaded.map.play_area,
            Some(Rect {
                x: 70.0,
                y: 140.0,
                w: 700.0,
                h: 490.0
            })
        );

        // A map staged on one evening for the next is only useful if it is still
        // staged when the server comes back up.
        let staged = loaded.staged.as_ref().expect("the staged map");
        assert_eq!(staged.map.url, "/uploads/next-week.jpg");
        assert_eq!(staged.map.grid_px, 96.0);
        // And the dungeon traced on it, which is the half of this slot that has
        // to survive a restart for the feature to be worth having.
        assert_eq!(staged.walls.len(), 1);
        assert_eq!(
            staged.walls.first().map(|w| w.door()),
            Some(Some(false)),
            "a staged door comes back shut, exactly as it was traced"
        );

        let token = loaded.tokens.first().expect("the token");
        // Invariant 1: grid units on the wire, on disk, everywhere but render.
        assert_eq!((token.x, token.y), (3.5, 12.5));
        assert_eq!(token.owner, Owner::Player(PlayerId::new("cleodara")));
        assert_eq!(token.size, 3.0);
        // An ambush set up at the end of one evening is still set up at the
        // start of the next, and the DM's running total with it.
        assert!(token.hidden);
        assert_eq!(
            token.hp,
            Some(Hp {
                current: 14,
                max: 31
            })
        );
        // And so is the plan for where it lands on that staged map. A plan that
        // did not survive the file would be lost exactly when it is wanted: the
        // next map is prepared on one evening to be promoted on another.
        assert_eq!(token.staged_pos, Some(Pos { x: 8.5, y: 2.5 }));
        assert!(!token.staged_only);

        assert_eq!(loaded.initiative.round, 4);
        assert_eq!(loaded.initiative.current, Some(TokenId::new("t1")));
        assert_eq!(loaded.initiative.entries.len(), 1);

        // Half an hour of tracing, and the map it belongs to will still be on
        // the board next week. Losing this to a restart would make the wall
        // editor something nobody used twice.
        assert_eq!(loaded.walls.len(), 2);
        let door = loaded.walls.get(1).expect("the door");
        assert_eq!(door.from, Px { x: 64.0, y: 320.0 });
        // Image pixels, not cells — invariant 1's exception. A wall stored in
        // grid units slides off the art the moment the grid is corrected.
        assert_eq!(door.to, Px { x: 64.0, y: 384.0 });
        // The open flag lives inside the tag, so a round trip that flattened
        // `WallKind` would come back as masonry rather than as a shut door.
        assert_eq!(door.kind, WallKind::Door(true));
        assert_eq!(door.door(), Some(true));

        // Slate is off between sessions, so a calibration that did not survive
        // the file would never be found again.
        let remembered = loaded
            .calibrations
            .get("/uploads/digital-goblin-camp-1a2b3c4d.jpg")
            .expect("the remembered calibration");
        assert_eq!(remembered.grid_px, 82.0);
        assert_eq!((remembered.offset_x, remembered.offset_y), (11.0, -6.0));
        assert_eq!(remembered.grid_color, "#00ff00ff");

        assert!(
            !loaded.show_names,
            "the DM turned the names off, and a restart is not them turning them back on"
        );
    }

    #[tokio::test]
    async fn a_missing_file_is_a_first_boot_not_a_failure() {
        let file = TempFile::new();
        assert!(file.store().load().await.expect("not an error").is_none());
    }

    #[tokio::test]
    async fn a_damaged_file_is_an_error_rather_than_an_empty_room() {
        let file = TempFile::new();
        std::fs::write(&file.0, b"{ this is not a room").expect("write");

        assert!(
            file.store().load().await.is_err(),
            "an empty room here would overwrite the real one"
        );
    }

    #[tokio::test]
    async fn saving_replaces_the_previous_save() {
        let file = TempFile::new();
        let store = file.store();

        store.save(&a_room()).await.expect("first save");
        let mut later = a_room();
        later.initiative.round = 9;
        store.save(&later).await.expect("second save");

        let loaded = store.load().await.expect("loads").expect("a room");
        assert_eq!(
            loaded.initiative.round, 9,
            "rename must replace an existing file"
        );
    }

    #[tokio::test]
    async fn a_finished_save_leaves_no_temp_file_behind() {
        let file = TempFile::new();
        let store = file.store();

        store.save(&a_room()).await.expect("saved");
        assert!(
            !store.tmp.exists(),
            "the temp file should have been renamed away"
        );
    }

    #[tokio::test]
    async fn a_save_from_an_older_schema_loads_with_defaults() {
        // Invariant 2. This is a file written before maps had an offset, before
        // tokens had an owner or an image, and before initiative existed.
        let file = TempFile::new();
        std::fs::write(
            &file.0,
            br#"{"map":{"url":"/assets/map.png"},"tokens":[{"id":"t1","name":"Cleodara","x":3.5,"y":12.5}]}"#,
        )
        .expect("write");

        let loaded = file.store().load().await.expect("loads").expect("a room");

        assert_eq!(loaded.map.url, "/assets/map.png");
        assert_eq!(
            loaded.map.grid_px, 64.0,
            "a missing grid size must not become a divide by zero"
        );
        assert_eq!((loaded.map.offset_x, loaded.map.offset_y), (0.0, 0.0));
        assert_eq!(
            loaded.map.grid_color, "#ffffff52",
            "a save predating the grid colour must get the default, not an empty string"
        );
        assert_eq!(
            loaded.map.play_area, None,
            "a save predating the play area means the whole image"
        );

        let token = loaded.tokens.first().expect("the token");
        assert_eq!((token.x, token.y), (3.5, 12.5));
        assert_eq!(
            token.owner,
            Owner::Dm,
            "an ownerless token fails closed, not open"
        );
        assert_eq!(
            token.size, 1.0,
            "a token saved before sizes existed must be one cell, never zero — \
             a zero-radius token is invisible and cannot be grabbed back"
        );
        assert!(
            !token.hidden,
            "a token saved before hiding existed was one the table could see; \
             defaulting the other way would empty the board on an upgrade"
        );
        assert_eq!(
            token.hp, None,
            "a save predating hit points means the DM keeps no total, not zero"
        );

        assert_eq!(
            loaded.initiative.round, 1,
            "combat starts on round 1, never round 0"
        );
        assert!(loaded.initiative.entries.is_empty());

        assert!(
            loaded.calibrations.is_empty(),
            "a save predating the table means nothing has been calibrated yet"
        );
        assert!(
            loaded.staged.is_none(),
            "a save predating staging has no next map waiting"
        );
        assert!(
            loaded.show_names,
            "a save predating the switch is a board that was drawing names; \
             defaulting the other way would strip every label on an upgrade"
        );
    }

    #[tokio::test]
    async fn a_save_from_a_newer_schema_still_loads() {
        // Rolling a build back must not brick the group's room.
        let file = TempFile::new();
        std::fs::write(
            &file.0,
            br#"{"tokens":[],"walls":[{"x1":0,"y1":0,"x2":4,"y2":0}],"weather":"rain"}"#,
        )
        .expect("write");

        let loaded = file.store().load().await.expect("loads").expect("a room");
        assert!(loaded.tokens.is_empty());
    }

    #[tokio::test]
    async fn saving_creates_the_directory_it_was_pointed_at() {
        // The Fedora box will point SLATE_STATE somewhere under /var/lib that
        // nothing has created yet.
        let dir = unique("slate-test-dir");
        let store = Store::new(dir.join("nested").join("room.json"));

        let saved = store.save(&a_room()).await;
        let loaded = store.load().await;
        let _ = std::fs::remove_dir_all(&dir);

        saved.expect("saved into a directory that did not exist");
        assert!(loaded.expect("loads").is_some());
    }
}

//! The room's snapshot on disk.
//!
//! One JSON file, rewritten whole. There is no database and no migration step:
//! invariant 2 puts `#[serde(default)]` on every persisted container, so a file
//! written by an older build still loads against a newer schema, and a field
//! this build has never heard of is ignored, not fatal.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::fog::{FogView, OverrideView};
use crate::protocol::{
    Colours, Diagonals, Initiative, MapInfo, Owner, Prepared, RosterEntry, Shape, StagedView,
    Token, Wall,
};

/// What actually goes to disk.
///
/// Neither `RoomView` nor `RoomState`. Not `RoomView`, because that is the room
/// as one client may see it, and fog of war makes those differ: the file must
/// hold everything. Not `RoomState`, because the DM secret comes from the
/// environment and connected clients die with the process.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    pub map: MapInfo,
    /// The map the DM is preparing, with the walls and overrides prepared on
    /// it. Persisted, but never part of a player's view.
    ///
    /// Saved for the same reason as the calibration table: a dungeon traced on a
    /// Tuesday for the Saturday has to survive any restart in between.
    ///
    /// The map inside it is flattened, so a file written when this was an
    /// `Option<MapInfo>` still loads its staged map. See `StagedView`.
    pub staged: Option<StagedView>,
    /// A list, not a map keyed by id: the id already lives inside each token,
    /// and the room rebuilds its `HashMap` on load.
    pub tokens: Vec<Token>,
    pub initiative: Initiative,
    /// Drawn shapes, in draw order. Already a `Vec` in the room, so unlike the
    /// tokens there is nothing to sort on the way out.
    ///
    /// Persisted so an area the DM places while prepping is still there when
    /// the party arrives. Sketches in progress are never saved; one lasts as
    /// long as a mouse button is held down.
    pub shapes: Vec<Shape>,
    /// Traced walls and doors, in image pixels. DM-only, like `calibrations` and
    /// `staged`.
    ///
    /// Tracing a dungeon is half an hour of work for a map that will still be on
    /// the board next week. Without persistence the wall editor would be
    /// unusable.
    pub walls: Vec<Wall>,
    /// Everywhere the party has explored, packed the way the wire packs it.
    ///
    /// Only `revealed` is saved. `visible` is derived from where the tokens
    /// stand and what blocks sight between them, both of which this file holds,
    /// so it is recomputed on boot. A stored copy could only disagree with the
    /// room: a door shut after the last save would show sight straight through
    /// it.
    ///
    /// `FogView`, not a list of cell pairs, for the same reason as on the wire:
    /// a few thousand characters laid out as a map instead of a few thousand
    /// numbers. The file records every explored cell as `o`, since it is packed
    /// against an empty `visible`, and `fog::unpack` reads both lit states the
    /// same way, so neither side has to know that.
    pub revealed: FogView,
    /// The DM's manual overrides, packed in their own alphabet: `#` forced dark,
    /// `o` forced explored, `*` forced in sight.
    ///
    /// Unlike `revealed`, nothing about this is derived. It is what the DM
    /// decided, and no walls or tokens could give it back, so it is restored
    /// whole, like the walls.
    pub overrides: OverrideView,
    /// Whether the board writes each token's name under it. Room-wide, and the
    /// DM's to set.
    ///
    /// **Carries its own default, because the container's is wrong for it.**
    /// Every field without one falls back to `Saved::default()`, where a bool is
    /// `false`, so a file written before this field existed would load with
    /// every name gone from the board. The safe default is whatever the room was
    /// already doing: `MapInfo::grid_px` follows the same rule, and so does
    /// `fog` defaulting off.
    #[serde(default = "shown")]
    pub show_names: bool,
    /// How the movement ruler charges a diagonal. Room-wide, and the DM's to set.
    ///
    /// Needs no default of its own: `Diagonals::Equal` is what the ruler did
    /// before this field existed, so the container's default is already what the
    /// room was doing. The variants are ordered to make that true.
    pub diagonals: Diagonals,
    /// Whether everybody's pointer is drawn on everybody's board. Room-wide, and
    /// the DM's to set.
    ///
    /// Defaults on for a different reason from `show_names`: rooms that predate
    /// this had no cursors, so "whatever the room was already doing" can't
    /// decide it. A feature switched off in every existing room is one nobody
    /// finds. A DM who doesn't want it has one checkbox; a DM who never learns
    /// it exists has nothing.
    #[serde(default = "shown")]
    pub show_cursors: bool,
    /// Whether the DM's own pointer is drawn on the players' boards. Room-wide,
    /// and the DM's to set.
    ///
    /// Defaults on because a file written before this field existed came from a
    /// room where the DM's pointer went out with everyone else's. Loading it as
    /// `false` would take a pointer off six screens without anyone asking.
    #[serde(default = "shown")]
    pub show_dm_cursor: bool,
    /// Everything the DM has prepared, keyed by map URL: the grid they
    /// calibrated, the walls they traced and the fog they painted.
    ///
    /// Not part of any client's view of the room. Persisted because an
    /// in-memory table would be empty after every restart, and re-picking last
    /// week's map needs to find its entry.
    ///
    /// It grows by an entry per distinct map ever set and is never pruned. A
    /// calibration is a hundred bytes; an entry with a fully traced dungeon is
    /// nearer a couple of hundred kilobytes. It still isn't worth a cap, because
    /// a cap would drop the half-hour of tracing this table exists to keep. The
    /// bound that matters is `MAX_WALLS`, applied where a wall is traced.
    pub calibrations: HashMap<String, Prepared>,
    /// Everybody's scratchpad, the DM's among them.
    ///
    /// **A list of pairs, not the `HashMap<Owner, String>` the room holds**,
    /// for two reasons that both come from this being a file. JSON has no object
    /// key an adjacently tagged enum can be written as, so a map would need
    /// `Owner` to have a string form invented for the disk and parsed back. And
    /// a list can be sorted, which stops the file churning on every write the
    /// way the token list does.
    ///
    /// Persisted because surviving a restart is what makes this worth more than
    /// the Notepad window everyone already has open. That has a limit: the DM
    /// hosts the server, so anyone holding this file can read every note. What
    /// the room guarantees is narrower: no client is ever sent somebody else's.
    pub notes: Vec<SavedNote>,
    /// Which colour each player picked, by roster slug.
    ///
    /// A map, where `notes` had to be a list. `Owner` is an adjacently tagged
    /// enum and JSON has no object key that can carry one, so the scratchpads
    /// are flattened into pairs and sorted by hand. `PlayerId` is a newtype over
    /// `String`, so it is a valid key already, and `BTreeMap` sorts itself.
    ///
    /// Persisted because a colour that had to be picked again every session
    /// would not be worth picking. It is the second field here a player writes,
    /// after the notes, and the second the undo ring is told to leave alone.
    pub colours: Colours,
    /// The picture in front of the table, or `None` for the board.
    ///
    /// Names an image but is not a map, which is why it is a string and not a
    /// second `MapInfo`: there is nothing to calibrate, trace or explore, so no
    /// other field here forks for it.
    ///
    /// Needs no default of its own, unlike the three `shown` fields. A file
    /// written before this existed came from a room with no backdrop, and the
    /// container's `None` loads it that way.
    pub backdrop: Option<String>,
    /// The room's cast, as the DM last edited it.
    ///
    /// **`None` means a file written before the roster was saved**, and the
    /// room keeps the seed from `ROOMS`. That is why this is an `Option` and not
    /// a list defaulting to empty: an empty list is a real roster (a new room,
    /// or a DM who removed everybody), and loading an old campaign save as one
    /// would turn six players away at the door. Every write since is `Some`.
    ///
    /// On the undo ring because every `Saved` is, and exempted there by hand:
    /// see the `Undo` arm of `apply`.
    pub roster: Option<Vec<RosterEntry>>,
}

/// One person's scratchpad as it is written down.
///
/// It never reaches the wire, so it lives here, not in `protocol.rs`. A client
/// is sent only its own `String` with no owner, because the only box it may
/// have is its own.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedNote {
    pub by: Owner,
    pub text: String,
}

/// The default for `Saved::show_names`, `Saved::show_cursors` and
/// `Saved::show_dm_cursor`. Serde wants a function, not a literal, and these are
/// the three fields here whose safe default is not the container's.
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
        // Appended to the whole path, not swapped for the extension, so it
        // can't collide with the save itself whatever the path looks like.
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

    /// `Ok(None)` means there is no save yet: a first boot, not a failure.
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
        Calibration, GridShape, Hp, InitiativeEntry, Lighting, Marker, Origin, Owner, PlayerId,
        Pos, Px, Rect, ShapeId, ShapeKind, TokenId, WallId, WallKind,
    };

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn unique(prefix: &str) -> PathBuf {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
    }

    /// A path under the OS temp dir, cleaned up when it drops. A leftover file
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
                grid_shape: GridShape::Square,
                play_area: Some(Rect {
                    x: 70.0,
                    y: 140.0,
                    w: 700.0,
                    h: 490.0,
                }),
                fog: true,
                vision_ft: 45.0,
                // Room, not the default: a field that only ever round-trips
                // its own default proves nothing about the round trip. The
                // other non-default values below are set for the same reason.
                lighting: Lighting::Room,
            },
            staged: Some(StagedView {
                map: MapInfo {
                    url: "/uploads/next-week.jpg".to_owned(),
                    grid_px: 96.0,
                    ..MapInfo::default()
                },
                // Traced on the Tuesday for the Saturday, which is why the
                // staged slot holds walls at all.
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
                // would produce for a token this wide.
                size: 3.0,
                hidden: true,
                hp: Some(Hp {
                    current: 14,
                    max: 31,
                }),
                // A lantern. Not `None`, because that is what a missing field
                // decodes to, so a round trip that dropped it would pass.
                light_ft: Some(30.0),
                // Not empty, for the same reason as `light_ft`. Two, not one,
                // because a list can round-trip its length wrongly.
                markers: vec![Marker::Red, Marker::Blue],
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
            // Anchored to the token above, because an anchored shape holds a
            // reference and so is the one a round trip could break.
            shapes: vec![Shape {
                id: ShapeId("s1".to_owned()),
                kind: ShapeKind::Circle,
                from: Origin::Token(TokenId::new("t1")),
                to: Pos { x: 4.0, y: 0.0 },
                by: Owner::Player(PlayerId::new("cleodara")),
                color: "#ff8c42e6".to_owned(),
            }],
            // One of each kind, because the door carries state inside its tag
            // and so is the one a round trip could flatten.
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
            // A ragged shape, not a filled rectangle: the packing is row-major,
            // and a solid block would survive being transposed.
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
            // Off, not the default.
            show_names: false,
            // Alternating: `Equal` is what a missing field decodes to, so a
            // round trip that lost this would pass.
            diagonals: Diagonals::Alternating,
            // Off: this defaults to `true`, so a round trip that dropped it
            // would come back on.
            show_cursors: false,
            // Off, for the same reason as `show_cursors`.
            show_dm_cursor: false,
            calibrations: HashMap::from([(
                "/uploads/digital-goblin-camp-1a2b3c4d.jpg".to_owned(),
                Prepared {
                    calibration: Calibration {
                        grid_px: 82.0,
                        offset_x: 11.0,
                        offset_y: -6.0,
                        grid_color: "#00ff00ff".to_owned(),
                        play_area: None,
                        fog: true,
                        vision_ft: 30.0,
                        lighting: Lighting::Room,
                        // Isometric, because the calibration is under a
                        // `#[serde(flatten)]` and this is an internally-tagged
                        // enum, which is the combination worth round-tripping.
                        grid_shape: GridShape::Iso { ratio: 2.0 },
                    },
                    // A map the DM prepared and then loaded away from. The
                    // calibration above is flattened, so these two sit beside
                    // its fields, not under a key of their own. That is why an
                    // older save still loads.
                    walls: vec![Wall {
                        id: WallId("w2".to_owned()),
                        from: Px { x: 8.0, y: 8.0 },
                        to: Px { x: 8.0, y: 200.0 },
                        kind: WallKind::Solid,
                    }],
                    overrides: crate::fog::pack_overrides(&HashMap::from([(
                        (4, 4),
                        Override::Dark,
                    )])),
                },
            )]),
            // One the DM's and one a player's, because a round trip could
            // collapse the pair: `Owner` is the only enum here used as a key,
            // and a form that lost its variant would give both boxes to one
            // person.
            notes: vec![
                SavedNote {
                    by: Owner::Dm,
                    text: "the innkeeper is lying".to_owned(),
                },
                SavedNote {
                    by: Owner::Player(PlayerId::new("cleodara")),
                    text: "ask about the sigil".to_owned(),
                },
            ],
            // Unlike `notes`, a JSON object keyed by the slug, which works only
            // because `PlayerId` is a newtype over `String`. The round trip has
            // to prove that too.
            colours: Colours::from([(PlayerId::new("cleodara"), 4), (PlayerId::new("saelyn"), 1)]),
            // Set, not the default. `None` is what a dropped field decodes to,
            // so a round trip that lost this would look like a DM who had put
            // the picture away.
            backdrop: Some("/uploads/backdrop-campfire-9f8e7d6c.jpg".to_owned()),
            roster: Some(vec![RosterEntry {
                id: PlayerId::new("mira"),
                name: "Mira of the Marsh".to_owned(),
            }]),
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
        // And the dungeon traced on it, which has to survive a restart for the
        // staged slot to be worth having.
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
        // And so is the plan for where it lands on that staged map. The next
        // map is prepared on one evening to be promoted on another, so a plan
        // that didn't survive the file would be lost when it was needed.
        assert_eq!(token.staged_pos, Some(Pos { x: 8.5, y: 2.5 }));
        assert!(!token.staged_only);

        assert_eq!(loaded.initiative.round, 4);
        assert_eq!(loaded.initiative.current, Some(TokenId::new("t1")));
        assert_eq!(loaded.initiative.entries.len(), 1);

        // Half an hour of tracing, for a map that will still be on the board
        // next week. Losing it to a restart would make the wall editor
        // something nobody used twice.
        assert_eq!(loaded.walls.len(), 2);
        let door = loaded.walls.get(1).expect("the door");
        assert_eq!(door.from, Px { x: 64.0, y: 320.0 });
        // Image pixels, not cells: invariant 1's exception. A wall stored in
        // grid units slides off the art as soon as the grid is corrected.
        assert_eq!(door.to, Px { x: 64.0, y: 384.0 });
        // The open flag lives inside the tag, so a round trip that flattened
        // `WallKind` would come back as masonry, not as an open door.
        assert_eq!(door.kind, WallKind::Door(true));
        assert_eq!(door.door(), Some(true));

        // A calibration that didn't survive the file would be gone after the
        // next restart.
        let remembered = loaded
            .calibrations
            .get("/uploads/digital-goblin-camp-1a2b3c4d.jpg")
            .expect("the remembered calibration");
        assert_eq!(remembered.calibration.grid_px, 82.0);
        assert_eq!(
            (
                remembered.calibration.offset_x,
                remembered.calibration.offset_y
            ),
            (11.0, -6.0)
        );
        assert_eq!(remembered.calibration.grid_color, "#00ff00ff");
        // And the rest of the shelf. The tracing is the main reason to keep
        // this table across a restart: a calibration is a minute's work and a
        // walled dungeon is an evening's.
        assert_eq!(remembered.walls.len(), 1);
        assert_eq!(
            remembered.walls.first().expect("the remembered wall").to,
            Px { x: 8.0, y: 200.0 }
        );
        assert_eq!(
            crate::fog::unpack_overrides(&remembered.overrides).get(&(4, 4)),
            Some(&Override::Dark)
        );

        assert!(
            !loaded.show_names,
            "the DM turned the names off, and a restart is not them turning them back on"
        );

        // The box is always on, so a picture the DM left up on Tuesday is what
        // the table should find on Saturday.
        assert_eq!(
            loaded.backdrop.as_deref(),
            Some("/uploads/backdrop-campfire-9f8e7d6c.jpg")
        );
        // The cast the DM edited, not the seed the code would give it back.
        let roster = loaded.roster.as_deref().expect("a saved roster");
        assert_eq!(roster.len(), 1);
        assert_eq!(roster[0].id, PlayerId::new("mira"));
        assert_eq!(roster[0].name, "Mira of the Marsh");
        assert!(
            !loaded.show_cursors,
            "and the same for the pointers: a table that decided against them \
             does not have to decide again every session"
        );
        assert!(
            !loaded.show_dm_cursor,
            "and the same again for the DM's own, which is a second switch and \
             not a second reading of the first"
        );

        // Surviving a restart is what a scratchpad is worth over the Notepad
        // window everyone already has open. Two boxes, kept apart: `Owner` is
        // the only enum here used as a key, and a form that lost the variant
        // would give both of these to one person.
        assert_eq!(loaded.notes.len(), 2);
        let mine = |by: &Owner| {
            loaded
                .notes
                .iter()
                .find(|note| &note.by == by)
                .map(|note| note.text.as_str())
        };
        assert_eq!(mine(&Owner::Dm), Some("the innkeeper is lying"));
        assert_eq!(
            mine(&Owner::Player(PlayerId::new("cleodara"))),
            Some("ask about the sigil")
        );

        // This table is a map where `notes` is a list because a slug is a
        // legal JSON key, so there is no encoding here to lose a name in.
        assert_eq!(loaded.colours.get(&PlayerId::new("cleodara")), Some(&4));
        assert_eq!(loaded.colours.get(&PlayerId::new("saelyn")), Some(&1));
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
        assert_eq!(
            loaded.map.grid_shape,
            GridShape::Square,
            "a save predating the cell shape is a square one, or every token on it moves"
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
        assert!(
            token.markers.is_empty(),
            "a token saved before markers existed carried none"
        );

        assert_eq!(
            loaded.initiative.round, 1,
            "combat starts on round 1, never round 0"
        );
        assert!(loaded.initiative.entries.is_empty());

        assert!(
            loaded.calibrations.is_empty(),
            "a save predating the table means nothing has been prepared yet"
        );
        assert!(
            loaded.staged.is_none(),
            "a save predating staging has no next map waiting"
        );
        assert!(
            loaded.backdrop.is_none(),
            "a save predating backdrops is a room looking at its board, which is \
             what the container's default already says"
        );
        assert!(
            loaded.show_names,
            "a save predating the switch is a board that was drawing names; \
             defaulting the other way would strip every label on an upgrade"
        );
        assert!(
            loaded.show_cursors,
            "a save predating cursors was drawing none, so this one cannot argue \
             from what the room was already doing — it defaults on because a \
             feature switched off in every existing room is one nobody finds"
        );
        assert!(
            loaded.show_dm_cursor,
            "a save predating this switch came from a room whose DM's pointer \
             went out with everybody else's, so loading it off would take a \
             pointer off six screens on an upgrade"
        );
    }

    #[tokio::test]
    async fn a_calibration_saved_before_the_shelf_loads_beside_empty_walls() {
        // Invariant 2 on a field whose shape changed. It gets its own test
        // because the failure is total and silent: every map the DM has ever
        // calibrated lives in this table, and an entry that stopped
        // deserializing would empty all of it on an upgrade.
        //
        // The entry here is an older save's: the calibration's own fields, with
        // no `walls` or `overrides` beside them. It loads because `Prepared`
        // flattens the calibration instead of nesting it under a key, as
        // `StagedView` does for the same reason.
        let file = TempFile::new();
        std::fs::write(
            &file.0,
            br#"{"tokens":[],"calibrations":{"/uploads/cave.png":{"grid_px":82,"offset_x":11,"offset_y":-6,"fog":true,"vision_ft":30}}}"#,
        )
        .expect("write");

        let loaded = file.store().load().await.expect("loads").expect("a room");
        let remembered = loaded
            .calibrations
            .get("/uploads/cave.png")
            .expect("the calibration is still there");

        assert_eq!(remembered.calibration.grid_px, 82.0);
        assert_eq!(
            (
                remembered.calibration.offset_x,
                remembered.calibration.offset_y
            ),
            (11.0, -6.0)
        );
        assert!(remembered.calibration.fog);
        assert_eq!(remembered.calibration.vision_ft, 30.0);
        assert!(
            remembered.walls.is_empty(),
            "a map prepared before the shelf existed had nothing traced on it, \
             which is exactly what an empty list says"
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
        // A deployment may point SLATE_STATE somewhere under /var/lib that
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

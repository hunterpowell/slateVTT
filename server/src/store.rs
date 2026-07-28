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

use crate::protocol::{Calibration, Initiative, MapInfo, Token};

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
    /// A list rather than a map keyed by id: the id already lives inside each
    /// token, and the room rebuilds its `HashMap` on load.
    pub tokens: Vec<Token>,
    pub initiative: Initiative,
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
    use crate::protocol::{InitiativeEntry, Owner, PlayerId, Rect, TokenId};

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
            },
            tokens: vec![Token {
                id: TokenId::new("t1"),
                name: "Grog".to_owned(),
                x: 3.5,
                y: 12.5,
                owner: Owner::Player(PlayerId::new("grog")),
                img: "/assets/tokens/grog.png".to_owned(),
            }],
            initiative: Initiative {
                entries: vec![InitiativeEntry {
                    token: TokenId::new("t1"),
                    value: 18,
                }],
                current: Some(TokenId::new("t1")),
                round: 4,
            },
            calibrations: HashMap::from([(
                "/uploads/digital-goblin-camp-1a2b3c4d.jpg".to_owned(),
                Calibration {
                    grid_px: 82.0,
                    offset_x: 11.0,
                    offset_y: -6.0,
                    grid_color: "#00ff00ff".to_owned(),
                    play_area: None,
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

        let token = loaded.tokens.first().expect("the token");
        // Invariant 1: grid units on the wire, on disk, everywhere but render.
        assert_eq!((token.x, token.y), (3.5, 12.5));
        assert_eq!(token.owner, Owner::Player(PlayerId::new("grog")));

        assert_eq!(loaded.initiative.round, 4);
        assert_eq!(loaded.initiative.current, Some(TokenId::new("t1")));
        assert_eq!(loaded.initiative.entries.len(), 1);

        // Slate is off between sessions, so a calibration that did not survive
        // the file would never be found again.
        let remembered = loaded
            .calibrations
            .get("/uploads/digital-goblin-camp-1a2b3c4d.jpg")
            .expect("the remembered calibration");
        assert_eq!(remembered.grid_px, 82.0);
        assert_eq!((remembered.offset_x, remembered.offset_y), (11.0, -6.0));
        assert_eq!(remembered.grid_color, "#00ff00ff");
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
            br#"{"map":{"url":"/assets/map.png"},"tokens":[{"id":"t1","name":"Grog","x":3.5,"y":12.5}]}"#,
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
            loaded.initiative.round, 1,
            "combat starts on round 1, never round 0"
        );
        assert!(loaded.initiative.entries.is_empty());

        assert!(
            loaded.calibrations.is_empty(),
            "a save predating the table means nothing has been calibrated yet"
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

//! The map library: the folder of maps on disk, listed and picked from.
//!
//! This is the only place a client-supplied path reaches the filesystem. An
//! upload sidesteps the problem by inventing its own name; a pick cannot, so a
//! requested path is checked twice. First structurally, before anything is
//! opened: a path must be a plain sequence of names, which rules out `..`, an
//! absolute path and a Windows drive prefix alike. Then against the
//! canonicalised library root, which is what catches a symlink that sits inside
//! `maps/` and points out of it.
//!
//! A pick is a copy into the uploads directory rather than a second way to serve
//! files, so the name of that copy has to be derived from the source path — the
//! same map picked twice must land on one file and one URL instead of piling up
//! a duplicate per pick.

use std::path::{Component, Path, PathBuf};

use tokio::fs;

/// Long enough for a deep, wordy map name, short enough that neither the listing
/// nor a copy's name can be grown without bound by whoever asks.
const MAX_PATH_LEN: usize = 256;
/// How much of the source path survives into the copy's name. The hash appended
/// after it is what actually keeps the name unique, so this only trades
/// readability against length.
const MAX_SLUG_LEN: usize = 60;
/// A library is a folder of maps, not a tree worth crawling. Both caps bound the
/// work one request can ask for.
const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 500;

/// What the listing offers. The pick itself identifies the real format from the
/// file's magic bytes, exactly as an upload does — an extension is only a hint
/// about what is worth showing the DM.
const IMAGE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

#[derive(Debug, PartialEq, Eq)]
pub enum PickError {
    /// Not a plain relative path inside the library. Never reported in any more
    /// detail than that: the difference between "malformed" and "outside the
    /// library" is only useful to someone probing for what is on the disk.
    Rejected,
    /// Well-formed, but there is no such map.
    Missing,
}

/// A requested path, proven to name a file inside the library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    /// The file itself, canonicalised.
    pub path: PathBuf,
    /// The relative path, lowercased with `/` separators. The copy's name comes
    /// from this rather than from what the client sent, so the same map asked
    /// for two different ways still resolves to one copy. Lowercasing is because
    /// the deployment target is Windows, where the two spellings are one file.
    pub key: String,
}

/// Rebuilds a requested path from its components, rejecting anything that is not
/// a plain relative path. Doing this before touching the filesystem means a
/// traversal never gets as far as being canonicalised.
fn normalise(requested: &str) -> Option<String> {
    if requested.is_empty() || requested.len() > MAX_PATH_LEN {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();
    for component in Path::new(requested).components() {
        // `Normal` is the only component a library path may contain. `ParentDir`
        // is the traversal, `RootDir` and `Prefix` are absolute paths, and
        // `CurDir` is a `./` that has no business being sent.
        let Component::Normal(part) = component else {
            return None;
        };
        parts.push(part.to_str()?.to_ascii_lowercase());
    }

    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Resolves a requested path against the library root.
pub fn resolve(maps_dir: &Path, requested: &str) -> Result<Pick, PickError> {
    let key = normalise(requested).ok_or(PickError::Rejected)?;

    let base = maps_dir.canonicalize().map_err(|_| PickError::Missing)?;
    let path = base
        .join(Path::new(requested))
        .canonicalize()
        .map_err(|_| PickError::Missing)?;

    // The component check above already makes a traversal unrepresentable, so
    // this is not that check repeated: `canonicalize` resolves symlinks, and a
    // link inside the library pointing outside it is the case only this catches.
    if !path.starts_with(&base) {
        return Err(PickError::Rejected);
    }
    if !path.is_file() {
        return Err(PickError::Missing);
    }

    Ok(Pick { path, key })
}

/// FNV-1a. Not a cryptographic hash and does not need to be — it distinguishes
/// two paths a DM actually has, and the path itself is not a secret.
fn fnv1a(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Everything that is not a letter or a digit becomes a single dash.
fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut trailing_dash = false;

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            trailing_dash = false;
        } else if !out.is_empty() && !trailing_dash {
            out.push('-');
            trailing_dash = true;
        }
    }

    // Only ASCII was pushed, so this cannot split a character in half.
    out.truncate(MAX_SLUG_LEN);
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// The name a picked map is copied to, derived from `Pick::key`.
///
/// Readable because `%LOCALAPPDATA%\Slate` is meant to be a backup someone can
/// look through, and hashed because the slug alone collides: two maps whose
/// names differ only in punctuation would otherwise overwrite each other and the
/// DM would pick one and get the other.
pub fn copy_name(key: &str, extension: &str) -> String {
    // The extension is dropped from the readable half — it is already the
    // extension of the copy — but stays in the hash, so the same name as a PNG
    // and as a JPEG remains two maps.
    let stem = key.rsplit_once('.').map_or(key, |(stem, _)| stem);
    let readable = slug(stem);
    let readable = if readable.is_empty() {
        "map"
    } else {
        &readable
    };
    format!("{readable}-{:08x}.{extension}", fnv1a(key.as_bytes()))
}

fn is_image(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
    })
}

/// Every map in the library, as paths relative to its root, with `/` separators.
///
/// Case is preserved: this is what the DM reads in the picker. `resolve` is what
/// folds it to a key, so a listing entry can be sent straight back as a pick.
///
/// An unreadable directory is skipped rather than failing the request — the rest
/// of the library is still worth showing.
pub async fn list(maps_dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(maps_dir.to_path_buf(), String::new(), 0)];

    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(mut entries) = fs::read_dir(&dir).await else {
            continue;
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            if found.len() >= MAX_ENTRIES {
                stack.clear();
                break;
            }

            // A name that is not UTF-8 could not survive the wire as JSON, and
            // there is nothing useful to show for it.
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if relative.len() > MAX_PATH_LEN {
                continue;
            }

            // Deliberately does not follow symlinks: a link is neither a file
            // nor a directory here, so it is skipped, and the walk cannot be
            // sent round a loop by one.
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    stack.push((entry.path(), relative, depth + 1));
                }
            } else if kind.is_file() && is_image(&name) {
                found.push(relative);
            }
        }
    }

    // Case-insensitively, so the order matches how the names read rather than
    // where the capitals happen to fall.
    found.sort_by_key(|entry| entry.to_lowercase());
    found
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// A library on disk, removed when it drops.
    struct TempLibrary(PathBuf);

    impl TempLibrary {
        fn new() -> Self {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("slate-maps-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("create the library");
            Self(dir)
        }

        fn with(&self, relative: &str) -> &Self {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create the subdirectory");
            }
            std::fs::write(&path, b"not really an image").expect("write the map");
            self
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempLibrary {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // --- what may reach the filesystem ---------------------------------------

    #[test]
    fn a_map_in_the_library_resolves() {
        let library = TempLibrary::new();
        library.with("Digital/Arctic Tundra.jpg");

        let pick = resolve(library.path(), "Digital/Arctic Tundra.jpg").expect("resolves");
        assert_eq!(pick.key, "digital/arctic tundra.jpg");
        assert!(pick.path.is_file());
    }

    #[test]
    fn a_traversal_never_escapes_the_library() {
        let library = TempLibrary::new();
        library.with("Digital/map.jpg");

        for attempt in [
            "../secret.jpg",
            "../../secret.jpg",
            "Digital/../../secret.jpg",
            "./Digital/map.jpg",
            "..",
        ] {
            assert_eq!(
                resolve(library.path(), attempt),
                Err(PickError::Rejected),
                "{attempt} should not have been accepted"
            );
        }
    }

    #[test]
    fn a_backslash_traversal_is_refused_too() {
        // The deployment target is Windows, where this is the spelling that
        // matters and where `\` is a separator `Path` actually splits on.
        let library = TempLibrary::new();
        library.with("Digital/map.jpg");

        for attempt in ["..\\secret.jpg", "Digital\\..\\..\\secret.jpg"] {
            assert_ne!(
                resolve(library.path(), attempt),
                Ok(Pick {
                    path: library.path().join("secret.jpg"),
                    key: "secret.jpg".to_owned(),
                }),
                "{attempt} should not have reached a file outside the library"
            );
        }
    }

    #[test]
    fn an_absolute_path_is_refused() {
        let library = TempLibrary::new();

        for attempt in [
            "/etc/passwd",
            "C:\\Windows\\System32\\drivers\\etc\\hosts",
            "\\\\server\\share\\map.jpg",
            "C:map.jpg",
        ] {
            assert_eq!(
                resolve(library.path(), attempt),
                Err(PickError::Rejected),
                "{attempt} should not have been accepted"
            );
        }
    }

    #[test]
    fn an_empty_or_oversized_path_is_refused() {
        let library = TempLibrary::new();
        assert_eq!(resolve(library.path(), ""), Err(PickError::Rejected));
        assert_eq!(
            resolve(library.path(), &"a".repeat(MAX_PATH_LEN + 1)),
            Err(PickError::Rejected)
        );
    }

    #[test]
    fn a_path_that_is_well_formed_but_absent_is_missing_rather_than_rejected() {
        let library = TempLibrary::new();
        assert_eq!(
            resolve(library.path(), "Digital/nothing here.jpg"),
            Err(PickError::Missing)
        );
    }

    #[test]
    fn a_directory_is_not_a_map() {
        let library = TempLibrary::new();
        library.with("Digital/map.jpg");
        assert_eq!(resolve(library.path(), "Digital"), Err(PickError::Missing));
    }

    // --- the key, and the name derived from it -------------------------------

    #[test]
    fn one_map_asked_for_two_ways_gives_one_key() {
        let library = TempLibrary::new();
        library.with("Digital/Arctic Tundra.jpg");

        let slash = resolve(library.path(), "Digital/Arctic Tundra.jpg").expect("resolves");
        let doubled = resolve(library.path(), "Digital//Arctic Tundra.jpg").expect("resolves");
        assert_eq!(slash.key, doubled.key);

        // Only meaningful where the filesystem agrees the two are one file.
        if cfg!(windows) {
            let shouted = resolve(library.path(), "DIGITAL/ARCTIC TUNDRA.JPG").expect("resolves");
            assert_eq!(
                slash.key, shouted.key,
                "case must not produce a second copy of one map"
            );
        }
    }

    #[test]
    fn a_copy_name_is_readable_and_stable() {
        let name = copy_name("digital/arctic tundra (digital).jpg", "jpg");
        assert!(
            name.starts_with("digital-arctic-tundra-digital-"),
            "{name} should have stayed readable"
        );
        assert!(name.ends_with(".jpg"));
        assert_eq!(
            name,
            copy_name("digital/arctic tundra (digital).jpg", "jpg"),
            "picking the same map twice must resolve to the same file"
        );
    }

    #[test]
    fn two_maps_that_slug_alike_still_get_their_own_file() {
        // The whole reason the name is not the slug on its own.
        let one = copy_name("digital/goblin camp.jpg", "jpg");
        let two = copy_name("digital/goblin-camp.jpg", "jpg");
        assert_ne!(
            one, two,
            "one of these maps would have overwritten the other"
        );
    }

    #[test]
    fn the_same_name_in_two_formats_is_two_maps() {
        assert_ne!(copy_name("cave.png", "png"), copy_name("cave.jpg", "jpg"));
    }

    #[test]
    fn a_copy_name_survives_a_path_with_nothing_sluggable_in_it() {
        let name = copy_name("...jpg", "jpg");
        assert!(name.starts_with("map-"), "{name} should have a usable stem");
        assert!(name.ends_with(".jpg"));
    }

    #[test]
    fn a_long_path_does_not_become_a_long_filename() {
        let name = copy_name(&format!("{}/map.jpg", "a directory".repeat(40)), "jpg");
        assert!(name.len() <= MAX_SLUG_LEN + "-00000000.jpg".len());
    }

    // --- listing -------------------------------------------------------------

    #[tokio::test]
    async fn the_listing_finds_maps_in_subdirectories() {
        let library = TempLibrary::new();
        library
            .with("Digital/Arctic Tundra.jpg")
            .with("Digital/Classic Dungeon.png")
            .with("top level.webp");

        assert_eq!(
            list(library.path()).await,
            vec![
                "Digital/Arctic Tundra.jpg".to_owned(),
                "Digital/Classic Dungeon.png".to_owned(),
                "top level.webp".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn the_listing_ignores_everything_that_is_not_an_image() {
        let library = TempLibrary::new();
        library
            .with("map.jpg")
            .with("notes.txt")
            .with("README.md")
            .with("no extension");

        assert_eq!(list(library.path()).await, vec!["map.jpg".to_owned()]);
    }

    #[tokio::test]
    async fn a_listed_map_can_be_picked_by_the_string_it_was_listed_as() {
        // The listing and the pick have to agree, or the picker is decorative.
        let library = TempLibrary::new();
        library.with("Digital/Forest Encampment (night).jpg");

        let listed = list(library.path()).await;
        let entry = listed.first().expect("one map");
        assert!(resolve(library.path(), entry).is_ok());
    }

    #[tokio::test]
    async fn a_library_that_is_not_there_lists_nothing_rather_than_failing() {
        let library = TempLibrary::new();
        assert!(list(&library.path().join("nope")).await.is_empty());
    }
}

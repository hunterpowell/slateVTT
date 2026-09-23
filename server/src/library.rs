//! The libraries: folders of maps, portraits, backdrops and tracks on disk,
//! listed, picked from, added to and removed from.
//!
//! This is where a client-supplied path reaches the filesystem, in two places.
//! A pick's requested path is checked twice. First structurally, before
//! anything is opened: a path must be a plain sequence of names, which rules
//! out `..`, an absolute path and a Windows drive prefix alike. Then against
//! the canonicalised library root, which catches a symlink that sits inside
//! the library and points out of it. An add is stricter (see `destination`).
//!
//! A pick is a copy into the uploads directory, not a second way to serve
//! files, so the name of that copy has to be derived deterministically: the
//! same file picked twice must land on one file and one URL instead of piling
//! up a duplicate per pick.

use std::path::{Component, Path, PathBuf};

use tokio::fs;

/// Long enough for a deep, wordy map name, short enough that neither the listing
/// nor a copy's name can be grown without bound by whoever asks.
const MAX_PATH_LEN: usize = 256;
/// How much of the source path survives into the copy's name. The hash appended
/// after it keeps the name unique, so this only trades readability against
/// length.
const MAX_SLUG_LEN: usize = 60;
/// How long a name the DM may give a file they are adding, before the sniffed
/// extension is put back on it. Shorter than a path because it is one segment.
const MAX_STEM_LEN: usize = 80;
/// A library is a folder of files, not a tree worth crawling. Both caps bound
/// the work one request can ask for.
const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 500;

/// One accepted format: the extension a copy is written under, and the predicate
/// that recognises it from the file's leading bytes.
///
/// A predicate, not an `(offset, literal)` table, because MP3 needs masking: a
/// bare MPEG frame header is eleven sync bits and a handful of reserved
/// fields, not a string. Everything else is one or two `starts_with`s and
/// would fit a table.
pub struct Format {
    pub extension: &'static str,
    pub matches: fn(&[u8]) -> bool,
}

/// What one library will list, accept and refuse.
///
/// One of four things a library differs by, beside its folder, its size cap
/// and what a copy's name is fingerprinted over (`Library` in `main.rs`).
pub struct Formats {
    /// Sniffed in order, first match wins. This decides what a file is; the
    /// list below only decides what is worth showing.
    pub formats: &'static [Format],
    /// What the listing shows, and what `filename` will strip so `bed.mp3`
    /// doesn't land as `bed.mp3.mp3`. A separate list because `.jpeg` is
    /// listed and never written, and `.oga` and `.opus` are the same file as
    /// `.ogg`.
    pub extensions: &'static [&'static str],
    /// The noun phrase both refusals are built from, so no sentence anywhere
    /// else can get out of step with the list.
    pub named: &'static str,
}

const PNG: Format = Format {
    extension: "png",
    matches: |bytes| bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
};
const JPEG: Format = Format {
    extension: "jpg",
    matches: |bytes| bytes.starts_with(&[0xff, 0xd8, 0xff]),
};
const WEBP: Format = Format {
    extension: "webp",
    matches: |bytes| bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
};

/// Every Ogg page opens with the capture pattern, page zero included, so this is
/// the same kind of check as PNG's. Vorbis and Opus are both Ogg here and both
/// are written `.ogg`: the leading bytes are identical either way, the codec is
/// named inside the stream, and browsers read it from there, not from the
/// extension.
const OGG: Format = Format {
    extension: "ogg",
    matches: |bytes| bytes.starts_with(b"OggS"),
};

/// **The loosest check here, and the only one worth distrusting.** An ID3 tag
/// is unambiguous and is what nearly every encoder writes, but a bare frame
/// header is eleven sync bits, so some other file could open with one by
/// accident. The three masks after it reject the combinations MPEG itself
/// calls reserved or invalid, which is as far as the leading bytes can go. A
/// false positive here is a track the browser visibly refuses to play, on a
/// route only the DM can reach.
const MP3: Format = Format {
    extension: "mp3",
    matches: |bytes| {
        if bytes.starts_with(b"ID3") {
            return true;
        }
        bytes.len() >= 3
            && bytes[0] == 0xff
            // Eleven sync bits.
            && (bytes[1] & 0xe0) == 0xe0
            // MPEG version `01` is reserved.
            && (bytes[1] & 0x18) != 0x08
            // Layer `00` is reserved.
            && (bytes[1] & 0x06) != 0x00
            // Bitrate index `1111` is invalid.
            && (bytes[2] & 0xf0) != 0xf0
    },
};

/// WebP's check with four different bytes. Unambiguous only because each
/// library sniffs against its own table: a RIFF container is a WebP in `maps/`
/// and a WAV in `tracks/`, and neither library is ever asked about the other's.
const WAV: Format = Format {
    extension: "wav",
    matches: |bytes| bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE",
};

pub const IMAGES: Formats = Formats {
    formats: &[PNG, JPEG, WEBP],
    extensions: &["png", "jpg", "jpeg", "webp"],
    named: "a PNG, JPEG or WebP image",
};

/// **`.m4a` is not accepted.** Its `ftyp` box carries a brand, and the brand
/// doesn't say whether there is a video track beside the audio: `M4A ` is
/// audio-only, but plenty of ordinary AAC files are stamped `mp42` or `isom`,
/// which an MP4 *video* carries too. Accepting any `ftyp` lets a film into the
/// music library, where it plays its soundtrack and looks like a bug;
/// accepting only `M4A ` refuses files that are fine. The DM can re-export
/// instead. If that stops being acceptable, the addition is one arm checking
/// both boxes.
pub const AUDIO: Formats = Formats {
    formats: &[OGG, MP3, WAV],
    extensions: &["ogg", "oga", "opus", "mp3", "wav"],
    named: "an MP3, Ogg or WAV track",
};

/// The format these bytes actually are, as the extension a copy of them is
/// written under, or `None` for something this library does not hold.
///
/// Not the filename and not the `Content-Type` header: the client controls
/// both and neither is evidence of what the file is. What this returns also
/// decides the `Content-Type` browsers are later served it with.
pub fn sniff(formats: &Formats, bytes: &[u8]) -> Option<&'static str> {
    formats
        .formats
        .iter()
        .find(|format| (format.matches)(bytes))
        .map(|format| format.extension)
}

#[derive(Debug, PartialEq, Eq)]
pub enum PickError {
    /// Not a plain relative path inside the library. Never reported in any more
    /// detail than that: the difference between "malformed" and "outside the
    /// library" is only useful to someone probing for what is on the disk.
    Rejected,
    /// Well-formed, but there is no such file.
    Missing,
}

/// A requested path, proven to name a file inside the library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    /// The file itself, canonicalised.
    pub path: PathBuf,
    /// The relative path, lowercased with `/` separators. The copy's name comes
    /// from this, not from what the client sent, so the same file asked for
    /// two different ways still resolves to one copy. Lowercased because on
    /// Windows, one of the hosts, the two spellings are one file.
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

    // The component check above already rules out a traversal. This catches
    // a different case: `canonicalize` resolves symlinks, and a link inside
    // the library pointing outside it is caught only here.
    if !path.starts_with(&base) {
        return Err(PickError::Rejected);
    }
    if !path.is_file() {
        return Err(PickError::Missing);
    }

    Ok(Pick { path, key })
}

/// Why a file could not be added to a library under the name the DM gave it.
#[derive(Debug, PartialEq, Eq)]
pub enum AddError {
    /// Not a plain filename this library could hold. Like `PickError::Rejected`,
    /// never reported in more detail than that.
    Rejected,
    /// Well-formed, and something is already called that.
    Taken,
}

/// Where a file the DM is adding should be written, from the name they sent and
/// the format its bytes turned out to be.
///
/// **The second place a client-supplied path reaches the filesystem, and it is
/// guarded more tightly than the first.** A pick may name a file in a
/// subdirectory, so it is normalised and then checked against the
/// canonicalised root. An add may not: the name has to be a *single*
/// component, so the result can't leave the library at all, instead of being
/// checked afterwards. Nothing is created except one file directly in the
/// folder, so there are no directories to make and none to tidy up after a
/// remove.
///
/// The extension is the sniffed one, never the supplied one. The DM's name
/// decides what the picker shows and what the copy's key is derived from; what
/// is in the file decides how it is served. A `.png` holding a JPEG would
/// otherwise be copied out under a wrong extension.
pub fn destination(
    dir: &Path,
    supplied: &str,
    extension: &str,
    formats: &Formats,
) -> Result<PathBuf, AddError> {
    let name = filename(supplied, extension, formats).ok_or(AddError::Rejected)?;
    let path = dir.join(&name);
    // Refused, not overwritten. Silently replacing a map is an outcome the DM
    // can't undo, and for a map it wouldn't even work the way it looks: a copy
    // is named from its path, so the old bytes would still be served under the
    // same URL. That's the asymmetry described in `docs/maps.md`.
    if path.exists() {
        return Err(AddError::Taken);
    }
    Ok(path)
}

/// The single filename an add may write, or `None`.
///
/// Windows and the Pi are both hosts, so this refuses what either would
/// mishandle, not only what Unix cares about: the characters Windows reserves,
/// its device names, and the trailing dots and spaces it strips on the way to
/// disk. A name that arrives as `nul`, or that silently becomes a different
/// one, is a file the DM can't then remove by asking for the name they gave.
fn filename(supplied: &str, extension: &str, formats: &Formats) -> Option<String> {
    if supplied.is_empty() || supplied.len() > MAX_PATH_LEN {
        return None;
    }

    // One plain component. A separator, a `..` or a drive prefix is refused;
    // taking the last segment instead would accept `../../evil.png` as
    // `evil.png`.
    let mut components = Path::new(supplied).components();
    let Some(Component::Normal(only)) = components.next() else {
        return None;
    };
    if components.next().is_some() {
        return None;
    }
    let only = only.to_str()?;

    // Dropped if it is one this library would list anyway, so `cave.png`
    // doesn't land as `cave.png.png`. Any other suffix is part of the name.
    let stem = only
        .rsplit_once('.')
        .filter(|(_, ext)| listed_extension(ext, formats))
        .map_or(only, |(stem, _)| stem);

    // Windows strips these on the way to disk, so a name ending in one would be
    // written as something other than what the listing later reports.
    let stem = stem.trim_matches(|ch: char| ch == '.' || ch == ' ');
    if stem.is_empty() || stem.len() > MAX_STEM_LEN {
        return None;
    }
    if stem.chars().any(|ch| {
        ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return None;
    }
    if is_reserved(stem) {
        return None;
    }

    Some(format!("{stem}.{extension}"))
}

/// The DOS device names, which Windows still resolves ahead of any file of the
/// same name, with or without an extension, in any case.
fn is_reserved(stem: &str) -> bool {
    const DEVICES: [&str; 4] = ["con", "prn", "aux", "nul"];
    let lower = stem.to_ascii_lowercase();
    if DEVICES.contains(&lower.as_str()) {
        return true;
    }
    let numbered = |prefix: &str| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|rest| matches!(rest, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
    };
    numbered("com") || numbered("lpt")
}

/// FNV-1a. Not a cryptographic hash and doesn't need to be: it distinguishes
/// two files a DM actually has, and neither is a secret.
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

    // Only ASCII was pushed, so this can't split a character in half.
    out.truncate(MAX_SLUG_LEN);
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// The name a picked file is copied to: a readable slug of `Pick::key`, and a
/// short hash of `fingerprint`.
///
/// Readable because the data directory (`%LOCALAPPDATA%\Slate` on Windows) is
/// meant to be a backup someone can look through. Hashed because the slug
/// alone collides: two files whose names differ only in punctuation would
/// overwrite each other, and the DM would pick one and get the other.
///
/// **The fingerprint is the caller's choice and the libraries differ on it**
/// (see `Library::names_by_content` in `main.rs`). Passing the key gives a name
/// that is stable across a change to the file's contents; passing the contents
/// gives one that changes with them. Either way the slug comes from the key,
/// so what the DM reads in the folder is the path they picked.
pub fn copy_name(key: &str, fingerprint: &[u8], extension: &str) -> String {
    // The extension is dropped from the readable half, since it is already the
    // extension of the copy. A key fingerprint keeps it, so the same name as a
    // PNG and as a JPEG stays two files; a content fingerprint doesn't need it,
    // because two encodings of one image are already different bytes.
    let stem = key.rsplit_once('.').map_or(key, |(stem, _)| stem);
    let readable = slug(stem);
    let readable = if readable.is_empty() {
        "map"
    } else {
        &readable
    };
    format!("{readable}-{:08x}.{extension}", fnv1a(fingerprint))
}

/// Whether this library would show a file with that extension.
/// Case-insensitive because the DM's filenames are. Both `listed` and the
/// stem-strip in `filename` call this, so they agree on what "an extension
/// this library holds" means.
fn listed_extension(extension: &str, formats: &Formats) -> bool {
    formats
        .extensions
        .contains(&extension.to_ascii_lowercase().as_str())
}

fn listed(name: &str, formats: &Formats) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, extension)| listed_extension(extension, formats))
}

/// Every file in the library this library would hold, as paths relative to its
/// root, with `/` separators.
///
/// Case is preserved: this is what the DM reads in the picker. `resolve` folds
/// it to a key, so a listing entry can be sent straight back as a pick.
///
/// An unreadable directory is skipped instead of failing the request, because
/// the rest of the library is still worth showing.
pub async fn list(maps_dir: &Path, formats: &Formats) -> Vec<String> {
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

            // A name that isn't UTF-8 can't survive the wire as JSON, and
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

            // Doesn't follow symlinks: a link is neither a file nor a
            // directory here, so it is skipped, and a link can't send the walk
            // round a loop.
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    stack.push((entry.path(), relative, depth + 1));
                }
            } else if kind.is_file() && listed(&name, formats) {
                found.push(relative);
            }
        }
    }

    // Case-insensitively, so the order matches how the names read, not where
    // the capitals fall.
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
        // On a Windows host this is the spelling that matters, and `\` is a
        // separator `Path` splits on.
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

    // --- what may be written into one ----------------------------------------

    #[test]
    fn a_plain_name_lands_directly_in_the_folder() {
        let library = TempLibrary::new();

        let path =
            destination(library.path(), "Cragmaw Hideout.png", "png", &IMAGES).expect("a place");
        assert_eq!(path.parent(), Some(library.path()));
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("Cragmaw Hideout.png"),
            "the DM's capitals and spaces are what they will read in the picker"
        );
    }

    #[test]
    fn the_sniffed_extension_wins_over_the_one_the_dm_sent() {
        // A `.png` holding a JPEG would otherwise be copied out under the
        // wrong extension, and the copy's `Content-Type` comes from that name.
        let library = TempLibrary::new();

        let path = destination(library.path(), "cave.png", "jpg", &IMAGES).expect("a place");
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("cave.jpg"));
    }

    #[test]
    fn a_name_that_is_not_an_image_name_keeps_all_of_itself() {
        // Only an extension this library would have listed is dropped. A map
        // called `cave.v2` is a map called `cave.v2`, not one called `cave`.
        let library = TempLibrary::new();

        let path = destination(library.path(), "cave.v2", "png", &IMAGES).expect("a place");
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("cave.v2.png")
        );
    }

    #[test]
    fn an_added_name_may_not_be_a_path_at_all() {
        // Tighter than a pick, which may name a file in a subdirectory. An add
        // writes one file directly into the folder, so anything with a
        // separator in it is refused. Taking its last segment instead would
        // accept a traversal as a different name.
        let library = TempLibrary::new();

        for attempt in [
            "../secret.png",
            "../../secret.png",
            "digital/cave.png",
            "digital\\cave.png",
            "/etc/passwd.png",
            "C:\\Windows\\evil.png",
            "",
            ".",
            "..",
            "   ",
            "...png",
        ] {
            assert_eq!(
                destination(library.path(), attempt, "png", &IMAGES),
                Err(AddError::Rejected),
                "{attempt} should not be a name a library can hold"
            );
        }
    }

    #[test]
    fn windows_reserved_names_and_characters_are_refused() {
        // The deployment target is a Pi and the fallback is a Windows box, so
        // this refuses what either would mishandle. A file written as `nul` is
        // one the DM can never remove by asking for the name they gave.
        let library = TempLibrary::new();

        for attempt in [
            "nul", "CON", "com1", "LPT9", "aux.png", "map:1", "what?", "a*b", "a|b",
        ] {
            assert_eq!(
                destination(library.path(), attempt, "png", &IMAGES),
                Err(AddError::Rejected),
                "{attempt} should not be a name a library can hold"
            );
        }

        // And the ones that only look like devices are fine.
        for allowed in ["console", "com10", "nul2", "auxiliary"] {
            assert!(
                destination(library.path(), allowed, "png", &IMAGES).is_ok(),
                "{allowed} is an ordinary name"
            );
        }
    }

    #[test]
    fn a_name_already_taken_is_refused_rather_than_overwritten() {
        // Silently replacing a map is an outcome the DM can't undo, and for a
        // map it wouldn't even do what it looks like, since the copy is named
        // from the path and the old bytes would still be served.
        let library = TempLibrary::new();
        library.with("cave.png");

        assert_eq!(
            destination(library.path(), "cave.png", "png", &IMAGES),
            Err(AddError::Taken)
        );
        // Same file, named the way the DM might type it a second time.
        assert_eq!(
            destination(library.path(), "cave", "png", &IMAGES),
            Err(AddError::Taken)
        );
    }

    #[test]
    fn an_added_name_is_one_a_pick_can_ask_for() {
        // `add` finishes by picking the file it just wrote, so what
        // `destination` produces has to resolve.
        let library = TempLibrary::new();

        let path =
            destination(library.path(), "Cragmaw Hideout.jpeg", "jpg", &IMAGES).expect("a place");
        std::fs::write(&path, b"not really an image").expect("write it");
        let name = path.file_name().and_then(|n| n.to_str()).expect("a name");

        let pick = resolve(library.path(), name).expect("resolves");
        assert_eq!(pick.key, "cragmaw hideout.jpg");
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

    /// A copy named from its path, the way a map is.
    fn by_path(key: &str, extension: &str) -> String {
        copy_name(key, key.as_bytes(), extension)
    }

    #[test]
    fn a_copy_name_is_readable_and_stable() {
        let name = by_path("digital/arctic tundra (digital).jpg", "jpg");
        assert!(
            name.starts_with("digital-arctic-tundra-digital-"),
            "{name} should have stayed readable"
        );
        assert!(name.ends_with(".jpg"));
        assert_eq!(
            name,
            by_path("digital/arctic tundra (digital).jpg", "jpg"),
            "picking the same map twice must resolve to the same file"
        );
    }

    #[test]
    fn a_slug_reads_as_the_path_however_the_name_was_fingerprinted() {
        // What the DM browses in the data directory comes from the key in
        // every library; only the eight hex digits after it differ.
        let name = copy_name("portrait/cleo.jpg", b"some image bytes", "jpg");
        assert!(
            name.starts_with("portrait-cleo-"),
            "{name} should have stayed readable"
        );
        assert!(name.ends_with(".jpg"));
    }

    #[test]
    fn two_maps_that_slug_alike_still_get_their_own_file() {
        // Why the name isn't the slug on its own.
        let one = by_path("digital/goblin camp.jpg", "jpg");
        let two = by_path("digital/goblin-camp.jpg", "jpg");
        assert_ne!(
            one, two,
            "one of these maps would have overwritten the other"
        );
    }

    #[test]
    fn the_same_name_in_two_formats_is_two_maps() {
        assert_ne!(by_path("cave.png", "png"), by_path("cave.jpg", "jpg"));
    }

    #[test]
    fn replacing_the_art_under_one_path_gives_a_new_name() {
        // The DM swaps the file in `portraits/`, re-picks it, and must not be
        // handed the copy made from the bytes it replaced.
        let before = copy_name("portrait/cleo.jpg", b"the old portrait", "jpg");
        let after = copy_name("portrait/cleo.jpg", b"the new portrait", "jpg");
        assert_ne!(
            before, after,
            "the replaced art would have kept resolving to the old copy"
        );
    }

    #[test]
    fn the_same_art_picked_twice_is_still_one_file() {
        // The other half: re-picking an unchanged portrait must not pile up a
        // duplicate per pick, just as for a map.
        assert_eq!(
            copy_name("portrait/cleo.jpg", b"the portrait", "jpg"),
            copy_name("portrait/cleo.jpg", b"the portrait", "jpg")
        );
    }

    #[test]
    fn a_copy_name_survives_a_path_with_nothing_sluggable_in_it() {
        let name = by_path("...jpg", "jpg");
        assert!(name.starts_with("map-"), "{name} should have a usable stem");
        assert!(name.ends_with(".jpg"));
    }

    #[test]
    fn a_long_path_does_not_become_a_long_filename() {
        let name = by_path(&format!("{}/map.jpg", "a directory".repeat(40)), "jpg");
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
            list(library.path(), &IMAGES).await,
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

        assert_eq!(
            list(library.path(), &IMAGES).await,
            vec!["map.jpg".to_owned()]
        );
    }

    #[tokio::test]
    async fn a_listed_map_can_be_picked_by_the_string_it_was_listed_as() {
        // The listing and the pick have to agree, or the picker is useless.
        let library = TempLibrary::new();
        library.with("Digital/Forest Encampment (night).jpg");

        let listed = list(library.path(), &IMAGES).await;
        let entry = listed.first().expect("one map");
        assert!(resolve(library.path(), entry).is_ok());
    }

    #[tokio::test]
    async fn a_library_that_is_not_there_lists_nothing_rather_than_failing() {
        let library = TempLibrary::new();
        assert!(list(&library.path().join("nope"), &IMAGES).await.is_empty());
    }

    #[tokio::test]
    async fn one_folder_lists_differently_to_two_libraries() {
        // The same folder, listed as two libraries, must give two answers. If
        // these ever agree, a track has become something the map picker
        // offers.
        let library = TempLibrary::new();
        library.with("cave.png").with("bed.ogg").with("boss.mp3");

        assert_eq!(list(library.path(), &IMAGES).await, vec!["cave.png"]);
        assert_eq!(
            list(library.path(), &AUDIO).await,
            vec!["bed.ogg".to_owned(), "boss.mp3".to_owned()]
        );
    }

    #[test]
    fn a_track_does_not_land_with_its_extension_twice() {
        // The stem-strip in `filename` must read this library's list. With the
        // images' list it wouldn't recognise `.mp3`, would keep it as part of
        // the name, and would write `boss.mp3.mp3`.
        let library = TempLibrary::new();
        let path =
            destination(library.path(), "boss.mp3", "mp3", &AUDIO).expect("a place for a track");
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("boss.mp3")
        );
    }

    #[test]
    fn a_suffix_this_library_does_not_hold_is_part_of_the_name() {
        // The other half of the rule above, and why the strip is per library
        // and not "drop whatever is after the last dot": a track called
        // `cave.png` keeps that name and gains the sniffed extension.
        let library = TempLibrary::new();
        let path =
            destination(library.path(), "cave.png", "ogg", &AUDIO).expect("a place for a track");
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("cave.png.ogg")
        );
    }
}

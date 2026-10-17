// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The tar container. Spec §6.4.
//!
//! With `fileNaming: "id"` the leaf name on disk is the document's ULID, so
//! the real file name has nowhere to live except inside the ciphertext.
//! §6.4 puts it in a single-entry tar archive, which means `age -d | tar -x`
//! hands back the file under its correct name — for any file type,
//! including binaries that cannot carry frontmatter.
//!
//! # What a conforming container is
//!
//! Exactly **one regular file entry**, whose name is the document's real
//! file name with **no directory component**. §6.4 requires a client to
//! reject an archive with more than one entry, a non-regular entry, or an
//! entry name containing `/` or `..` — and §11.5 makes the reason explicit:
//! a tar entry name arrives from outside and is untrusted input. An archive
//! naming `../../.ssh/authorized_keys` must be refused, not extracted.

use std::io::Read;

/// Why a container could not be built or read.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// §6.4: exactly one entry.
    #[error("the container holds no entries")]
    Empty,
    /// §6.4: exactly one entry.
    #[error("the container holds more than one entry")]
    TooManyEntries,
    /// §6.4: a regular file, not a directory, link or device.
    #[error("the container's entry is not a regular file")]
    NotARegularFile,
    /// §6.4 and §11.5: the name is the file's own, with no path.
    #[error("the container's entry name is not a plain file name: {0:?}")]
    UnsafeName(String),
    /// The archive itself will not parse.
    #[error("the container is not a readable tar archive: {0}")]
    Malformed(String),
    /// The entry is shorter than its header says. A truncated payload that
    /// returned its partial contents would be data loss reported as
    /// success.
    #[error("the container's entry is truncated: {declared} bytes declared, {actual} present")]
    Truncated { declared: u64, actual: u64 },
    /// ustar stores a name in 100 bytes. Longer names need a pax or GNU
    /// extension, which writes additional entries that §6.4's
    /// one-entry rule would then reject.
    #[error("{0:?} is too long for the container ({1} bytes; the limit is 100)")]
    NameTooLong(String, usize),
}

/// The longest entry name a ustar header can hold.
pub const MAX_NAME_BYTES: usize = 100;

/// Wrap one file in a single-entry tar archive. Spec §6.4.
///
/// `name` must be the document's own file name, with no directory part —
/// the same thing a reader is required to insist on.
pub fn wrap(name: &str, contents: &[u8]) -> Result<Vec<u8>, Error> {
    check_name(name)?;
    if name.len() > MAX_NAME_BYTES {
        return Err(Error::NameTooLong(name.to_string(), name.len()));
    }

    let mut header = tar::Header::new_ustar();
    header.set_size(contents.len() as u64);
    header.set_entry_type(tar::EntryType::Regular);
    // Owner-only, and no uid, gid, or user name: §11.2 lists what an
    // encrypted vault still leaks, and there is no reason to add the
    // author's account details to it.
    header.set_mode(0o600);
    header.set_uid(0);
    header.set_gid(0);
    // A fixed mtime, so that re-encrypting an unchanged document does not
    // change the plaintext. age output is non-deterministic anyway, but the
    // container should not add a second reason for churn.
    header.set_mtime(0);
    header
        .set_path(name)
        .map_err(|err| Error::Malformed(err.to_string()))?;
    header.set_cksum();

    let mut builder = tar::Builder::new(Vec::new());
    builder
        .append(&header, contents)
        .map_err(|err| Error::Malformed(err.to_string()))?;
    builder
        .into_inner()
        .map_err(|err| Error::Malformed(err.to_string()))
}

/// What a container held.
#[derive(Debug)]
pub struct Unwrapped {
    /// The document's real file name.
    pub name: String,
    pub contents: Vec<u8>,
}

/// Read a single-entry tar archive, enforcing every rejection §6.4 lists.
pub fn unwrap(archive: &[u8]) -> Result<Unwrapped, Error> {
    let mut reader = tar::Archive::new(archive);
    let entries = reader
        .entries()
        .map_err(|err| Error::Malformed(err.to_string()))?;

    let mut found: Option<Unwrapped> = None;
    for entry in entries {
        let mut entry = entry.map_err(|err| Error::Malformed(err.to_string()))?;

        if found.is_some() {
            return Err(Error::TooManyEntries);
        }

        if !entry.header().entry_type().is_file() {
            return Err(Error::NotARegularFile);
        }

        // Taken from the header as raw bytes rather than as a resolved
        // path: `..` and `/` must be judged as they were written, not after
        // any normalisation.
        let name = String::from_utf8_lossy(&entry.path_bytes()).to_string();
        check_name(&name)?;

        let declared = entry.header().size().unwrap_or(0);
        let mut contents = Vec::new();
        entry
            .read_to_end(&mut contents)
            .map_err(|err| Error::Malformed(err.to_string()))?;

        // Load-bearing, and not a belt-and-braces check. For an archive
        // cut off inside the entry's body the reader returns the bytes it
        // found and reports no error at all, so without this a truncated
        // payload would yield a short document and call it success. Cuts
        // further along — inside the trailing padding — the reader does
        // catch. `a_truncated_archive_is_rejected` covers both windows.
        if contents.len() as u64 != declared {
            return Err(Error::Truncated {
                declared,
                actual: contents.len() as u64,
            });
        }

        found = Some(Unwrapped { name, contents });
    }

    found.ok_or(Error::Empty)
}

/// Whether `name` is a plain file name. Spec §6.4, §11.5.
fn check_name(name: &str) -> Result<(), Error> {
    let unsafe_name = name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
        || name.contains('\0');
    if unsafe_name {
        return Err(Error::UnsafeName(name.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_round_trips() {
        let archive = match wrap("notes.md", b"# Notes\n") {
            Ok(archive) => archive,
            Err(err) => panic!("{err}"),
        };
        let unwrapped = match unwrap(&archive) {
            Ok(unwrapped) => unwrapped,
            Err(err) => panic!("{err}"),
        };
        assert_eq!(unwrapped.name, "notes.md");
        assert_eq!(unwrapped.contents, b"# Notes\n");
    }

    #[test]
    fn a_name_with_a_space_round_trips() {
        // The acceptance criterion for this milestone, at the unit level:
        // the name is why the container exists.
        let archive = wrap("my sync design.md", b"body").expect("wrap");
        let unwrapped = unwrap(&archive).expect("unwrap");
        assert_eq!(unwrapped.name, "my sync design.md");
    }

    #[test]
    fn non_ascii_and_binary_survive() {
        let name = "notes — café.md";
        let contents: Vec<u8> = (0..=255u8).cycle().take(3000).collect();
        let archive = wrap(name, &contents).expect("wrap");
        let unwrapped = unwrap(&archive).expect("unwrap");
        assert_eq!(unwrapped.name, name);
        assert_eq!(unwrapped.contents, contents);
    }

    #[test]
    fn an_empty_file_round_trips() {
        let archive = wrap("empty.md", b"").expect("wrap");
        let unwrapped = unwrap(&archive).expect("unwrap");
        assert_eq!(unwrapped.name, "empty.md");
        assert!(unwrapped.contents.is_empty());
    }

    // --- §6.4's rejections, one test each ---------------------------------

    #[test]
    fn an_empty_archive_is_rejected() {
        let builder = tar::Builder::new(Vec::new());
        let archive = builder.into_inner().expect("build");
        assert!(matches!(unwrap(&archive), Err(Error::Empty)));
    }

    #[test]
    fn two_entries_are_rejected() {
        let mut builder = tar::Builder::new(Vec::new());
        for name in ["one.md", "two.md"] {
            let mut header = tar::Header::new_ustar();
            header.set_size(4);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o600);
            header.set_path(name).expect("path");
            header.set_cksum();
            builder.append(&header, &b"body"[..]).expect("append");
        }
        let archive = builder.into_inner().expect("build");
        assert!(matches!(unwrap(&archive), Err(Error::TooManyEntries)));
    }

    #[test]
    fn a_non_regular_entry_is_rejected() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_ustar();
        header.set_size(0);
        header.set_entry_type(tar::EntryType::Directory);
        header.set_mode(0o700);
        header.set_path("adirectory").expect("path");
        header.set_cksum();
        builder.append(&header, &b""[..]).expect("append");
        let archive = builder.into_inner().expect("build");
        assert!(matches!(unwrap(&archive), Err(Error::NotARegularFile)));
    }

    #[test]
    fn an_entry_name_with_a_directory_is_rejected() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_ustar();
        header.set_size(4);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o600);
        header.set_path("nested/notes.md").expect("path");
        header.set_cksum();
        builder.append(&header, &b"body"[..]).expect("append");
        let archive = builder.into_inner().expect("build");
        match unwrap(&archive) {
            Err(Error::UnsafeName(name)) => assert_eq!(name, "nested/notes.md"),
            other => panic!("expected UnsafeName, got {other:?}"),
        }
    }

    /// A 512-byte ustar header, written by hand.
    ///
    /// The `tar` crate refuses to *write* a path containing `..`, which is
    /// the right default and useless for this test: §11.5 says an entry
    /// name is untrusted input, and someone sending a hostile archive is
    /// not going to be stopped by our writer's good manners. So the bytes
    /// are assembled directly, the way an attacker's would be.
    fn hostile_archive(name: &str, contents: &[u8]) -> Vec<u8> {
        hostile_archive_declaring(name, contents, contents.len())
    }

    /// The same, but with a size field that need not match the body.
    fn hostile_archive_declaring(name: &str, contents: &[u8], declared: usize) -> Vec<u8> {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..107].copy_from_slice(b"0000600");
        header[108..115].copy_from_slice(b"0000000");
        header[116..123].copy_from_slice(b"0000000");
        let size = format!("{declared:011o}");
        header[124..135].copy_from_slice(size.as_bytes());
        header[136..147].copy_from_slice(b"00000000000");
        // The checksum is computed with its own field read as spaces.
        header[148..156].copy_from_slice(b"        ");
        header[156] = b'0'; // a regular file
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let checksum: u32 = header.iter().map(|byte| *byte as u32).sum();
        let rendered = format!("{checksum:06o}\0 ");
        header[148..156].copy_from_slice(rendered.as_bytes());

        let mut archive = header.to_vec();
        archive.extend_from_slice(contents);
        // Pad the body to a 512-byte boundary, then two empty blocks.
        archive.resize(512 + contents.len().div_ceil(512) * 512, 0);
        archive.extend_from_slice(&[0u8; 1024]);
        archive
    }

    #[test]
    fn the_hand_built_header_is_a_valid_archive() {
        // Otherwise the hostile tests below would pass for the wrong
        // reason: a rejection of our own malformed bytes, not of the name.
        let archive = hostile_archive("notes.md", b"body");
        let unwrapped = unwrap(&archive).expect("the harness must build valid archives");
        assert_eq!(unwrapped.name, "notes.md");
        assert_eq!(unwrapped.contents, b"body");
    }

    #[test]
    fn an_entry_name_that_escapes_is_rejected() {
        // §11.5: extracting this would write outside the repository.
        for name in [
            "../../.ssh/authorized_keys",
            "../escape.md",
            "/etc/passwd",
            "nested/notes.md",
        ] {
            let archive = hostile_archive(name, b"body");
            match unwrap(&archive) {
                Err(Error::UnsafeName(reported)) => assert_eq!(reported, name),
                other => panic!("{name:?} was not rejected: {other:?}"),
            }
        }
    }

    #[test]
    fn rubbish_is_not_an_archive() {
        assert!(matches!(
            unwrap(b"this is not a tar archive at all, not even close"),
            Err(Error::Malformed(_)) | Err(Error::Empty)
        ));
    }

    #[test]
    fn a_truncated_archive_is_rejected() {
        // A 56-byte body in a 2048-byte archive: header, body, padding to
        // 1024, then two empty blocks. Three windows behave differently,
        // and all three are correct.
        let contents = b"a body long enough that half an archive loses some of it";
        let archive = wrap("notes.md", contents).expect("wrap");
        assert_eq!(archive.len(), 2048);

        // Cut inside the body: the reader hands back what it found without
        // complaint, so the size check is the only thing standing between a
        // truncated payload and a silently short document.
        for cut in [512, 520, 540, 560] {
            match unwrap(&archive[..cut]) {
                Err(Error::Truncated { declared, actual }) => {
                    assert_eq!(declared, contents.len() as u64);
                    assert!(actual < declared, "{actual} is not short of {declared}");
                }
                other => panic!("a cut at {cut} gave {other:?}"),
            }
        }

        // Cut inside the padding: the reader catches this one itself.
        for cut in [568, 600, 1000] {
            assert!(
                unwrap(&archive[..cut]).is_err(),
                "a cut at {cut} was accepted"
            );
        }

        // Past the entry, only the trailing empty blocks are missing. The
        // document is whole, so accepting it is right — rejecting more than
        // the format requires would be its own bug.
        for cut in [1024, archive.len() - 1] {
            let unwrapped = unwrap(&archive[..cut])
                .unwrap_or_else(|err| panic!("a cut at {cut} was rejected: {err}"));
            assert_eq!(unwrapped.contents, contents);
        }
    }

    #[test]
    fn a_size_field_larger_than_the_real_content_is_not_malformed() {
        // Tempting to call this a lying header, but tar's size field *is*
        // the authority on how long the content is: this is a valid file
        // whose tail happens to be zeros, and rejecting it would reject
        // every document that legitimately ends in a NUL byte.
        let archive = hostile_archive_declaring("notes.md", b"short", 400);
        let unwrapped = unwrap(&archive).expect("a valid archive");
        assert_eq!(unwrapped.contents.len(), 400);
        assert_eq!(&unwrapped.contents[..5], b"short");
        assert!(unwrapped.contents[5..].iter().all(|byte| *byte == 0));
    }

    // --- Writing ---------------------------------------------------------

    #[test]
    fn a_name_with_a_path_is_never_written() {
        // The same rule a reader enforces, applied before the bytes exist.
        for name in ["nested/notes.md", "..", ".", "", "a\\b"] {
            assert!(
                matches!(wrap(name, b"body"), Err(Error::UnsafeName(_))),
                "{name:?} was accepted"
            );
        }
    }

    #[test]
    fn a_name_too_long_for_ustar_is_refused_rather_than_mangled() {
        // A pax or GNU extension would store it, but by writing extra
        // entries that §6.4's one-entry rule then rejects. Refusing is
        // honest; producing an archive a conforming reader must reject is
        // not.
        let long = format!("{}.md", "a".repeat(MAX_NAME_BYTES));
        match wrap(&long, b"body") {
            Err(Error::NameTooLong(_, bytes)) => assert_eq!(bytes, long.len()),
            other => panic!("expected NameTooLong, got {other:?}"),
        }

        // And the limit itself is usable.
        let exact = "a".repeat(MAX_NAME_BYTES);
        assert!(wrap(&exact, b"body").is_ok());
    }

    #[test]
    fn the_container_is_deterministic() {
        // No timestamp, uid or user name, so the same document produces the
        // same bytes. age output is non-deterministic regardless; the
        // container should not add a second reason for churn.
        let first = wrap("notes.md", b"body").expect("wrap");
        let second = wrap("notes.md", b"body").expect("wrap");
        assert_eq!(first, second);
    }
}

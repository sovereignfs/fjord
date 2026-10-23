// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#![cfg(feature = "native")]
// These read repositories from a disk, which the pure subset has no part in.

//! The conformance suite: `fjord verify` against every fixture.
//!
//! # Why some fixtures are not committed
//!
//! A fixture for most of the `E5xx` path rules **cannot** be a committed
//! directory, and the reason is the rules themselves. A repository holding
//! both `Notes.md` and `notes.md` does not check out on macOS; one holding
//! `CON.md`, `a?b.md` or a name ending in a space does not check out on
//! Windows. Committing those fixtures would make this repository unclonable
//! on the very platforms the rules exist to protect.
//!
//! So fixtures come in four kinds, and `every_diagnostic_is_covered` holds
//! the list:
//!
//! - **Committed** — `tests/fixtures/broken/<code>/`, for defects
//!   expressible as ordinary portable files.
//! - **Synthesised** — built into a temporary directory by a test below,
//!   for names no repository should carry.

//! - **Predicate-only** — reachable through a `fjord_core` API but not
//!   through a read-only filesystem scan, because no filesystem can store
//!   the offending name, or because the thing checked is inside a
//!   ciphertext.

use fjord_core::diagnostics::Code;
use fjord_core::verify::{self, Options, Report};
use std::fs;
use std::path::{Path, PathBuf};

/// Committed fixtures, each emitting exactly the code it is named for.
const COMMITTED: &[&str] = &[
    "E101", "E102", "E103", "E104", "E105", "E106", "E108", "E109", "E110", "E201", "E202", "E203",
    "E204", "E206", "E207", "E208", "E209", "E301", "E302", "E304", "E305", "E306", "E401", "E402",
    "E403", "E404", "E405", "E507", "W601", "W602",
];

/// Built at test time: a name that must never reach a commit.
const SYNTHESISED: &[&str] = &[
    "E501", "E502", "E503", "E505", "E506", "E508", "W604", "W605",
];

/// Codes no filesystem scan can reach, covered by unit tests on the
/// predicate instead.
///
/// - `E504`: no mainstream filesystem stores a path component over 255
///   bytes, so it can only be caught by validating a name *before* writing
///   it — which is what `fjord new` and `fjord vault add` do. Covered by
///   `length_is_measured_in_bytes` in `fjord_core::path`.
/// - `E303`: the tar archive lives *inside* the ciphertext (§6.4), so
///   checking it needs an identity and `fjord verify` never asks for one.
///   It surfaces when a document is read, and is covered exhaustively by
///   `fjord_core::container`'s tests — one per rejection §6.4 lists — plus
///   an end-to-end test that reading a malformed container reports it.
const PREDICATE_ONLY: &[&str] = &["E303", "E504"];

/// Nothing is deferred any longer: every diagnostic is implemented.
const DEFERRED: &[&str] = &[];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn run(root: &Path) -> Report {
    match verify::verify(root, &Options::default()) {
        Ok(report) => report,
        Err(err) => panic!("verify failed on {}: {err}", root.display()),
    }
}

/// The codes one run emitted, sorted, so a fixture's expectation does not
/// depend on the order checks happen to run in.
fn codes(root: &Path) -> Vec<String> {
    let mut codes: Vec<String> = run(root)
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str().to_string())
        .collect();
    codes.sort();
    codes
}

// --- The committed fixtures ----------------------------------------------

#[test]
fn the_conforming_fixture_emits_nothing() {
    let report = run(&fixtures().join("conforming"));
    assert!(
        report.diagnostics.is_empty(),
        "a conforming repository produced diagnostics: {:#?}",
        report.diagnostics
    );
    assert!(report.conforms());
    assert!(!report.read_only);
    assert_eq!(report.version, Some(1));

    // Both vaults are found from the filesystem, not from the manifest.
    let mut paths: Vec<&str> = report.vaults.iter().map(|v| v.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, vec!["Private", "Public"]);

    let private = report
        .vaults
        .iter()
        .find(|v| v.path == "Private")
        .expect("Private vault summary");
    assert!(private.encrypted);
    assert_eq!(private.recipients, 1);

    let public = report
        .vaults
        .iter()
        .find(|v| v.path == "Public")
        .expect("Public vault summary");
    assert!(!public.encrypted);
    assert_eq!(public.docs, 1, "welcome.md should be recognised as a Doc");
}

#[test]
fn each_committed_fixture_emits_exactly_its_code() {
    for code in COMMITTED {
        let root = fixtures().join("broken").join(code);
        assert!(root.is_dir(), "missing fixture directory for {code}");
        let found = codes(&root);
        assert_eq!(
            found,
            vec![code.to_string()],
            "fixture {code} emitted {found:?}"
        );
    }
}

/// A fixture directory that nothing expects would be dead weight, and a
/// renamed code would otherwise leave one behind.
#[test]
fn no_committed_fixture_is_unaccounted_for() {
    let broken = fixtures().join("broken");
    let mut on_disk = Vec::new();
    for entry in fs::read_dir(&broken).expect("broken fixtures directory") {
        let entry = entry.expect("fixture directory entry");
        if entry.path().is_dir() {
            on_disk.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    on_disk.sort();

    let mut expected: Vec<String> = COMMITTED.iter().map(|c| c.to_string()).collect();
    expected.sort();
    assert_eq!(on_disk, expected);
}

#[test]
fn every_diagnostic_is_covered() {
    for code in Code::all() {
        let id = code.as_str();
        let covered = COMMITTED.contains(&id)
            || SYNTHESISED.contains(&id)
            || PREDICATE_ONLY.contains(&id)
            || DEFERRED.contains(&id);
        assert!(
            covered,
            "{id} has no fixture and is not recorded as deferred — see this file's doc comment"
        );
    }
}

/// Invariant 7: `fjord verify` mutates nothing. A `--fix` that strayed into
/// the read-only path, or a check that rewrote a manifest it had just
/// normalised, would show up here.
#[test]
fn verify_mutates_nothing() {
    let root = fixtures().join("conforming");
    let before = tree_digest(&root);
    run(&root);
    let after = tree_digest(&root);
    assert_eq!(before, after, "verify changed the repository on disk");
}

/// A digest over every path and its bytes, so a changed, added or removed
/// file all register.
fn tree_digest(root: &Path) -> String {
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.sort();

    let mut hasher = blake3::Hasher::new();
    for (relative, bytes) in files {
        hasher.update(relative.as_bytes());
        hasher.update(&[0]);
        hasher.update(&bytes);
        hasher.update(&[0]);
    }
    hasher.finalize().to_hex().to_string()
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    for entry in fs::read_dir(dir).expect("readable fixture directory") {
        let entry = entry.expect("fixture entry");
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).expect("entry metadata");
        if metadata.is_dir() {
            walk(root, &path, out);
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("entry inside the fixture")
                .to_string_lossy()
                .to_string();
            out.push((relative, fs::read(&path).expect("readable fixture file")));
        }
    }
}

// --- The synthesised fixtures --------------------------------------------

const REPOSITORY_MANIFEST: &str = r#"{
  "fjord": 1,
  "id": "01jagc4k7pqw2xn8rvty5zb3md",
  "name": "Fixture",
  "createdAt": "2026-10-16T09:34:00Z",
  "vaults": [{ "path": "Public", "id": "01jagc4k7pr9tbm3ykwx6zq2hv" }]
}
"#;

const VAULT_MANIFEST: &str = r#"{
  "fjord": 1,
  "id": "01jagc4k7pr9tbm3ykwx6zq2hv",
  "name": "Public",
  "createdAt": "2026-10-16T09:34:00Z",
  "encryption": null,
  "fileNaming": "plain"
}
"#;

const GITATTRIBUTES: &str = "*         text=auto eol=lf\n*.age     binary -diff -merge\n";

/// The same minimal conforming repository the committed fixtures are built
/// from: one plaintext vault, no documents, no diagnostics.
fn scaffold() -> tempfile::TempDir {
    let temp = tempfile::tempdir().expect("temporary directory");
    let root = temp.path();
    fs::write(root.join("fjord.json"), REPOSITORY_MANIFEST).expect("write fjord.json");
    fs::write(root.join(".gitattributes"), GITATTRIBUTES).expect("write .gitattributes");
    fs::create_dir(root.join("Public")).expect("create Public");
    fs::write(root.join("Public/fjord.vault.json"), VAULT_MANIFEST).expect("write vault manifest");
    temp
}

#[test]
fn the_scaffold_itself_is_conforming() {
    // Otherwise a synthesised fixture's expectation would be measuring the
    // scaffold rather than the defect.
    let temp = scaffold();
    assert_eq!(codes(temp.path()), Vec::<String>::new());
}

#[test]
fn e501_forbidden_character() {
    let temp = scaffold();
    // `?` is legal on Unix and fatal on Windows, which is the whole point.
    fs::write(temp.path().join("Public").join("a?b.md"), "# hi\n").expect("write");
    assert_eq!(codes(temp.path()), vec!["E501"]);
}

#[test]
fn e502_trailing_space() {
    let temp = scaffold();
    fs::write(temp.path().join("Public").join("notes.md "), "# hi\n").expect("write");
    assert_eq!(codes(temp.path()), vec!["E502"]);
}

#[test]
fn e503_reserved_device_name() {
    let temp = scaffold();
    fs::write(temp.path().join("Public").join("CON.md"), "# hi\n").expect("write");
    assert_eq!(codes(temp.path()), vec!["E503"]);
}

// --- Documents and notes (spec §8.4) -------------------------------------

#[test]
fn the_documents_fixture_conforms_and_has_one_of_each() {
    // `documents/` is a conforming repository whose Public vault holds a document (`plan.fj.md`) and a note
    // (`idea.md`): the same format, told apart by name alone (spec §8.4).
    let report = run(&fixtures().join("documents"));
    assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    let public = report
        .vaults
        .iter()
        .find(|v| v.path == "Public")
        .expect("Public");
    assert_eq!((public.docs, public.files), (2, 0));
}

const DOC_ID_A: &str = "01jagc4k7pt8y3wqnmzv5xrb9a";
const DOC_ID_B: &str = "01jagc4k7pt8y3wqnmzv5xrb9b";

fn doc(id: &str) -> String {
    format!("---\nid: {id}\ntitle: T\n---\n\n# T\n")
}

fn public_summary(root: &Path) -> (usize, usize) {
    let report = run(root);
    let public = report
        .vaults
        .iter()
        .find(|v| v.path == "Public")
        .expect("Public");
    (public.docs, public.files)
}

#[test]
fn a_document_and_a_note_are_both_docs() {
    let temp = scaffold();
    let public = temp.path().join("Public");
    fs::write(public.join("plan.fj.md"), doc(DOC_ID_A)).expect("write");
    fs::write(public.join("idea.md"), doc(DOC_ID_B)).expect("write");
    assert_eq!(codes(temp.path()), Vec::<String>::new());
    assert_eq!(public_summary(temp.path()), (2, 0));
}

#[test]
fn a_document_without_an_id_is_a_vault_file_like_any_markdown_file() {
    // §8.4: the name decides what kind of Doc a file is, not whether it is one; that is the frontmatter's.
    let temp = scaffold();
    let public = temp.path().join("Public");
    fs::write(public.join("draft.fj.md"), "# just a draft\n").expect("write");
    fs::write(public.join("plain.md"), "# just a note\n").expect("write");
    assert_eq!(codes(temp.path()), Vec::<String>::new());
    assert_eq!(public_summary(temp.path()), (0, 2));
}

#[test]
fn an_id_is_unique_across_documents_and_notes() {
    let temp = scaffold();
    let public = temp.path().join("Public");
    fs::write(public.join("plan.fj.md"), doc(DOC_ID_A)).expect("write");
    fs::write(public.join("copy.md"), doc(DOC_ID_A)).expect("write");
    assert_eq!(codes(temp.path()), vec!["E401"]);
}

#[test]
fn e505_case_collision() {
    let temp = scaffold();
    let public = temp.path().join("Public");
    fs::write(public.join("Notes.md"), "# hi\n").expect("write");

    // On a case-insensitive filesystem the collision cannot be created at
    // all — the second write lands on the first file. That is the data loss
    // the rule exists to prevent, so there is nothing to assert here.
    if public.join("notes.md").exists() {
        return;
    }
    fs::write(public.join("notes.md"), "# hi\n").expect("write");
    assert_eq!(codes(temp.path()), vec!["E505"]);
}

#[test]
fn e506_not_nfc_normalised() {
    let temp = scaffold();
    let public = temp.path().join("Public");
    // "cafe" plus a combining acute accent: NFD.
    let decomposed = "cafe\u{0301}.md";
    fs::write(public.join(decomposed), "# hi\n").expect("write");

    // Some filesystems normalise on the way in. If this one did, the name
    // on disk is already NFC and there is nothing to report.
    let stored = fs::read_dir(&public)
        .expect("read Public")
        .filter_map(|entry| entry.ok())
        .any(|entry| entry.file_name().to_string_lossy() == decomposed);
    if !stored {
        return;
    }

    assert_eq!(codes(temp.path()), vec!["E506"]);
}

#[cfg(unix)]
#[test]
fn e508_symlink_escapes_the_repository() {
    let temp = scaffold();
    std::os::unix::fs::symlink("/etc/passwd", temp.path().join("Public").join("escape"))
        .expect("create symlink");
    assert_eq!(codes(temp.path()), vec!["E508"]);
}

#[cfg(unix)]
#[test]
fn a_symlink_inside_the_repository_is_not_an_escape() {
    let temp = scaffold();
    std::os::unix::fs::symlink(
        temp.path().join("fjord.json"),
        temp.path().join("Public").join("link"),
    )
    .expect("create symlink");
    assert_eq!(codes(temp.path()), Vec::<String>::new());
}

#[test]
fn w604_file_too_large() {
    let temp = scaffold();
    let path = temp.path().join("Public").join("scan.bin");
    let file = fs::File::create(&path).expect("create");
    // Sparse: the metadata reports 26 MB without writing 26 MB.
    file.set_len(26 * 1024 * 1024).expect("set_len");
    drop(file);
    assert_eq!(codes(temp.path()), vec!["W604"]);
}

#[test]
fn w605_path_too_long() {
    let temp = scaffold();
    let deep = temp
        .path()
        .join("Public")
        .join("a".repeat(80))
        .join("b".repeat(80))
        .join("c".repeat(80));
    fs::create_dir_all(&deep).expect("create nested directories");
    fs::write(deep.join("notes.md"), "# hi\n").expect("write");
    assert_eq!(codes(temp.path()), vec!["W605"]);
}

// --- Behaviour the fixtures cannot express -------------------------------

#[test]
fn a_newer_format_version_is_read_only() {
    // Invariant 4: reading is permitted, writing must be refused.
    let report = run(&fixtures().join("broken").join("E103"));
    assert!(report.read_only);
    assert_eq!(report.version, Some(2));
    assert!(!report.conforms());
}

#[test]
fn warnings_do_not_break_conformance() {
    let report = run(&fixtures().join("broken").join("W601"));
    assert_eq!(report.errors(), 0);
    assert_eq!(report.warnings(), 1);
    assert!(report.conforms(), "a warning must not fail conformance");
}

#[test]
fn a_missing_manifest_stops_there() {
    // E101 is terminal: without fjord.json there is no repository to check,
    // and reporting a missing .gitattributes too would just be noise.
    let report = run(&fixtures().join("broken").join("E101"));
    assert_eq!(report.diagnostics.len(), 1);
    assert!(report.vaults.is_empty());
}

#[test]
fn one_vault_can_be_checked_alone() {
    let options = Options {
        vault: Some("Private".to_string()),
    };
    let root = fixtures().join("broken").join("E201");
    let report = verify::verify(&root, &options).expect("verify");
    assert_eq!(report.vaults.len(), 1);
    assert_eq!(report.vaults[0].path, "Private");

    // Repository-wide checks still run; only vault content is narrowed.
    let options = Options {
        vault: Some("Public".to_string()),
    };
    let report = verify::verify(&root, &options).expect("verify");
    assert!(
        report.conforms(),
        "Private's plaintext should not be reported when only Public is checked: {:#?}",
        report.diagnostics
    );
}

// --- The old spelling -----------------------------------------------------
//
// Spec §8.3 required uppercase identifiers until 2026-10-17, and Fjord 0.1.0
// wrote them. Such a repository does not conform to the current revision, and
// the likeliest reason a valid-looking id is refused is that it is the old
// spelling. So the refusal has to say so — while accepting nothing that was
// not accepted before, because §8.3 permits exactly one form.

fn detail_of(root: &Path, code: &str) -> String {
    let report = run(root);
    match report
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == code)
    {
        Some(diagnostic) => diagnostic.detail.clone().unwrap_or_default(),
        None => panic!("{code} was not emitted: {:#?}", report.diagnostics),
    }
}

#[test]
fn an_uppercase_document_id_is_refused_and_the_refusal_says_why() {
    let temp = scaffold();
    fs::write(
        temp.path().join("Public/old.md"),
        "---\nid: 01JAGC4K7PT8Y3WQNMZV5XRB7H\ntitle: Old\n---\n\n# Old\n",
    )
    .expect("write");

    // Still refused: nothing more lenient than before.
    assert_eq!(codes(temp.path()), vec!["E403"]);
    assert!(!run(temp.path()).conforms());

    let detail = detail_of(temp.path(), "E403");
    assert!(detail.contains("uppercase"), "{detail}");
    assert!(detail.contains("lowercase"), "{detail}");
    assert!(detail.contains("0.1.0"), "{detail}");
}

#[test]
fn an_uppercase_repository_id_is_refused_and_explained() {
    let temp = scaffold();
    let manifest = fs::read_to_string(temp.path().join("fjord.json")).expect("read");
    fs::write(
        temp.path().join("fjord.json"),
        manifest.replace(
            "\"id\": \"01jagc4k7pqw2xn8rvty5zb3md\"",
            "\"id\": \"01JAGC4K7PQW2XN8RVTY5ZB3MD\"",
        ),
    )
    .expect("write");

    assert_eq!(codes(temp.path()), vec!["E105"]);
    assert!(detail_of(temp.path(), "E105").contains("uppercase"));
}

#[test]
fn an_uppercase_vault_entry_id_is_refused_and_explained() {
    let temp = scaffold();
    let manifest = fs::read_to_string(temp.path().join("fjord.json")).expect("read");
    fs::write(
        temp.path().join("fjord.json"),
        manifest.replace(
            "\"id\": \"01jagc4k7pr9tbm3ykwx6zq2hv\"",
            "\"id\": \"01JAGC4K7PR9TBM3YKWX6ZQ2HV\"",
        ),
    )
    .expect("write");

    assert_eq!(codes(temp.path()), vec!["E105"]);
    let detail = detail_of(temp.path(), "E105");
    assert!(detail.contains("vaults[0].id"), "{detail}");
    assert!(detail.contains("uppercase"), "{detail}");
}

#[test]
fn an_uppercase_id_file_name_is_refused_and_explained() {
    // The `id` naming mode of §7.2, where the leaf on disk is the id.
    let temp = tempfile::tempdir().expect("temporary directory");
    copy_directory(&fixtures().join("broken").join("E304"), temp.path());
    fs::rename(
        temp.path().join("Private/notes.age"),
        temp.path().join("Private/01JAGC4K7PQW2XN8RVTY5ZB3MD.age"),
    )
    .expect("rename");

    assert_eq!(codes(temp.path()), vec!["E304"]);
    assert!(detail_of(temp.path(), "E304").contains("uppercase"));
}

#[test]
fn a_genuine_typo_is_not_blamed_on_case() {
    // The hint must not fire for a different problem: sending someone to
    // lowercase an id that has an excluded letter in it would waste their
    // time. `i` is not in Crockford base32.
    let temp = scaffold();
    fs::write(
        temp.path().join("Public/typo.md"),
        "---\nid: 01jagc4k7pqw2xn8rvty5zb3mi\ntitle: Typo\n---\n\n# Typo\n",
    )
    .expect("write");

    assert_eq!(codes(temp.path()), vec!["E403"]);
    let detail = detail_of(temp.path(), "E403");
    assert!(!detail.contains("uppercase"), "{detail}");
    assert!(detail.contains("01jagc4k7pqw2xn8rvty5zb3mi"), "{detail}");
}

fn copy_directory(from: &Path, to: &Path) {
    for entry in fs::read_dir(from).expect("read fixture directory") {
        let entry = entry.expect("fixture entry");
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            fs::create_dir_all(&target).expect("create");
            copy_directory(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy");
        }
    }
}

// --- A recipient that looks right and is not -------------------------------

/// `verify` used to check a recipient's shape only: prefix, length and
/// alphabet. One mistyped character leaves all three intact and breaks the
/// checksum, so a vault nothing could encrypt to was reported with 0 errors
/// and 0 warnings — and counted as having a usable recipient, which also
/// suppressed W602.
#[test]
fn a_recipient_whose_checksum_fails_is_reported_not_counted() {
    let temp = tempfile::tempdir().expect("temporary directory");
    copy_directory(&fixtures().join("conforming"), temp.path());

    let path = temp.path().join("Private/recipients.txt");
    let mut text = fs::read_to_string(&path).expect("read");
    // Right prefix, right length, right alphabet — and not a key.
    text.push_str(&format!("age1{}\n", "q".repeat(58)));
    fs::write(&path, text).expect("write");

    assert_eq!(codes(temp.path()), vec!["E209"]);
    let report = run(temp.path());
    let private = report
        .vaults
        .iter()
        .find(|vault| vault.path == "Private")
        .expect("Private");
    assert_eq!(
        private.recipients, 1,
        "the bad key was counted as a usable recipient"
    );
}

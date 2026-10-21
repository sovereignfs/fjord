// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord export` and `fjord import`. Spec §6, §8.2.
//!
//! The README calls `export` the escape hatch and promises it is
//! "deliberately simple and will keep working". The first test is that
//! promise: a whole encrypted vault comes out as plain files under their
//! real names, and the round trip through `import` puts them back.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}

impl Repo {
    fn run(&self, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("TMPDIR", self.temp.path())
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .env_remove("EDITOR");
        command.output().expect("run fjord")
    }

    fn outside(&self, name: &str) -> PathBuf {
        self.temp.path().join(name)
    }
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("exit code")
}

fn out(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn err(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn repo() -> Repo {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let config = temp.path().join("config");
    let repo = Repo { temp, root, config };

    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &repo.root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(init.status.code(), Some(0), "{}", err(&init));

    let generated = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &repo.config)
        .current_dir(repo.temp.path())
        .output()
        .expect("key new");
    assert_eq!(generated.status.code(), Some(0), "{}", err(&generated));
    let report: Value = serde_json::from_slice(&generated.stdout).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();
    assert_eq!(
        code(&repo.run(&["key", "add", &recipient, "--vault", "Private"])),
        0
    );

    repo
}

/// Files under a directory, relative and sorted.
fn files_in(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).expect("read").flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.push(
                    path.strip_prefix(root)
                        .expect("inside")
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let mut found = Vec::new();
    walk(root, root, &mut found);
    found.sort();
    found
}

// --- The escape hatch -----------------------------------------------------

#[test]
fn a_whole_encrypted_vault_comes_out_as_plain_files() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Private/notes.md", "--title", "Notes", "--no-edit"])),
        0
    );
    assert_eq!(
        code(&repo.run(&["new", "Private/Inbox/deeper.md", "--no-edit"])),
        0
    );
    // A non-Markdown file too: the vault holds more than documents.
    std::fs::write(repo.root.join("Private/scan.bin"), [0u8, 1, 2, 255]).expect("write");
    assert_eq!(code(&repo.run(&["encrypt", "Private/scan.bin"])), 0);

    let destination = repo.outside("exported");
    let exported = repo.run(&["export", "Private", &destination.to_string_lossy()]);
    assert_eq!(code(&exported), 0, "{}{}", out(&exported), err(&exported));

    // Real names, real directory structure, no `.age` anywhere.
    assert_eq!(
        files_in(&destination),
        vec![
            "Inbox/deeper.md".to_string(),
            "notes.md".to_string(),
            "scan.bin".to_string(),
        ]
    );
    assert!(std::fs::read_to_string(destination.join("notes.md"))
        .expect("read")
        .contains("title: Notes"));
    assert_eq!(
        std::fs::read(destination.join("scan.bin")).expect("read"),
        vec![0u8, 1, 2, 255]
    );

    // And it says out loud that these are decrypted.
    assert!(out(&exported).contains("decrypted"), "{}", out(&exported));
}

#[test]
fn export_and_import_round_trip() {
    let repo = repo();
    let body = "# Groceries\n\nmilk\noats\n";
    std::fs::write(repo.root.join("Private/groceries.md"), body).expect("write");
    assert_eq!(code(&repo.run(&["encrypt", "Private/groceries.md"])), 0);

    let destination = repo.outside("exported");
    assert_eq!(
        code(&repo.run(&["export", "Private", &destination.to_string_lossy()])),
        0
    );

    // What came out is exactly what went in: this file never had
    // frontmatter, and `encrypt`/`export` do not invent any.
    assert_eq!(
        std::fs::read_to_string(destination.join("groceries.md")).expect("read"),
        body
    );

    // Back in, into a fresh vault.
    assert_eq!(code(&repo.run(&["vault", "add", "Restored"])), 0);
    let imported = repo.run(&["import", &destination.to_string_lossy(), "Restored"]);
    assert_eq!(code(&imported), 0, "{}{}", out(&imported), err(&imported));

    // Not byte-identical, and that is the documented behaviour rather than
    // a leak: a Markdown file without frontmatter is promoted to a Doc on
    // import (§8.2). The body is untouched and the metadata is new.
    let restored = std::fs::read_to_string(repo.root.join("Restored/groceries.md")).expect("read");
    assert!(restored.ends_with(body), "the body changed:\n{restored}");
    assert!(restored.contains("title: Groceries"), "{restored}");
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

/// A file that was already a Doc survives the round trip byte for byte —
/// the case where "export then import" has to be lossless, because there
/// is nothing left to add.
#[test]
fn a_doc_round_trips_byte_for_byte() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Private/notes.md", "--title", "Notes", "--no-edit"])),
        0
    );
    let destination = repo.outside("exported");
    assert_eq!(
        code(&repo.run(&["export", "Private", &destination.to_string_lossy()])),
        0
    );
    let exported = std::fs::read_to_string(destination.join("notes.md")).expect("read");

    assert_eq!(code(&repo.run(&["vault", "add", "Restored"])), 0);
    assert_eq!(
        code(&repo.run(&["import", &destination.to_string_lossy(), "Restored"])),
        0
    );

    assert_eq!(
        std::fs::read_to_string(repo.root.join("Restored/notes.md")).expect("read"),
        exported,
        "a Doc should come back exactly as it went out"
    );
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn an_id_vault_exports_under_the_real_names() {
    // The case export earns its keep: on disk these files are ULIDs, and
    // their names exist only inside the containers (§7.2).
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["vault", "add", "Secret", "--encrypted", "--id-naming"])),
        0
    );
    let listed = repo.run(&["key", "list", "--vault", "Private", "--json"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let recipient = rows[0]["recipients"][0]
        .as_str()
        .expect("recipient")
        .to_string();
    assert_eq!(
        code(&repo.run(&["key", "add", &recipient, "--vault", "Secret"])),
        0
    );
    assert_eq!(
        code(&repo.run(&["new", "Secret/quarterly report.md", "--no-edit"])),
        0
    );

    let destination = repo.outside("exported");
    assert_eq!(
        code(&repo.run(&["export", "Secret", &destination.to_string_lossy()])),
        0
    );
    assert_eq!(
        files_in(&destination),
        vec!["quarterly report.md".to_string()],
        "the container's name should be used, not the ULID on disk"
    );
}

#[test]
fn a_plaintext_vault_exports_without_an_identity() {
    let repo = repo();
    let blind = repo.outside("no-identity");
    std::fs::create_dir_all(&blind).expect("create");

    let destination = repo.outside("exported");
    let exported = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .arg("-C")
        .arg(&repo.root)
        .args(["export", "Public"])
        .arg(&destination)
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &blind)
        .env_remove("FJORD_IDENTITY")
        .output()
        .expect("run");
    assert_eq!(exported.status.code(), Some(0), "{}", err(&exported));
    assert_eq!(files_in(&destination), vec!["welcome.md".to_string()]);
}

// --- import ---------------------------------------------------------------

#[test]
fn markdown_without_frontmatter_is_promoted_to_a_doc() {
    // §8.2 permits assigning an id on an explicit instruction, which this
    // is, while forbidding it on a mere scan.
    let repo = repo();
    let source = repo.outside("incoming");
    std::fs::create_dir_all(source.join("Projects")).expect("create");
    std::fs::write(source.join("plain.md"), "# A Heading\n\nbody\n").expect("write");
    std::fs::write(source.join("Projects/nested.md"), "no heading here\n").expect("write");
    std::fs::write(source.join("data.csv"), "a,b\n1,2\n").expect("write");

    let imported = repo.run(&["import", &source.to_string_lossy(), "Private"]);
    assert_eq!(code(&imported), 0, "{}{}", out(&imported), err(&imported));
    assert!(out(&imported).contains("3 files"), "{}", out(&imported));
    assert!(
        out(&imported).contains("2 files gained frontmatter"),
        "{}",
        out(&imported)
    );

    let listed = repo.run(&["ls", "Private", "-R", "--json"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let rows = rows.as_array().expect("array");

    // The heading became the title; the file name did for the one without.
    let plain = rows
        .iter()
        .find(|r| r["path"] == "Private/plain.md")
        .expect("plain.md");
    assert_eq!(plain["kind"], Value::from("doc"));
    assert_eq!(plain["title"], Value::from("A Heading"));

    let nested = rows
        .iter()
        .find(|r| r["path"] == "Private/Projects/nested.md")
        .expect("nested.md");
    assert_eq!(nested["title"], Value::from("nested"));

    // §8: a CSV is a vault file, with no metadata and none expected.
    let csv = rows
        .iter()
        .find(|r| r["path"] == "Private/data.csv")
        .expect("data.csv");
    assert_eq!(csv["kind"], Value::from("file"));
    assert_eq!(csv["id"], Value::Null);

    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn an_existing_doc_keeps_its_identity_and_its_keys() {
    // §8.2: `id` is immutable, and unknown keys survive (invariant 3).
    let repo = repo();
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    let original =
        "---\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntitle: Theirs\nobsidianPlugin: true\n---\n\nbody\n";
    std::fs::write(source.join("theirs.md"), original).expect("write");

    assert_eq!(
        code(&repo.run(&["import", &source.to_string_lossy(), "Public"])),
        0
    );
    let stored = std::fs::read_to_string(repo.root.join("Public/theirs.md")).expect("read");
    assert_eq!(stored, original, "an existing Doc should come in untouched");
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn an_import_into_an_id_vault_names_files_by_id() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["vault", "add", "Secret", "--encrypted", "--id-naming"])),
        0
    );
    let listed = repo.run(&["key", "list", "--vault", "Private", "--json"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let recipient = rows[0]["recipients"][0]
        .as_str()
        .expect("recipient")
        .to_string();
    assert_eq!(
        code(&repo.run(&["key", "add", &recipient, "--vault", "Secret"])),
        0
    );

    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("my notes.md"), "# Notes\n").expect("write");

    assert_eq!(
        code(&repo.run(&["import", &source.to_string_lossy(), "Secret"])),
        0
    );

    // Named by ULID on disk, with the real name inside the container.
    let stored = files_in(&repo.root.join("Secret"));
    let payload = stored
        .iter()
        .find(|name| name.ends_with(".age"))
        .expect("a payload");
    assert_eq!(payload.len(), 26 + 4, "expected a ULID name, got {payload}");

    let shown = repo.run(&["ls", "Secret", "--long"]);
    assert!(out(&shown).contains("my notes.md"), "{}", out(&shown));
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

/// A repository with a writable `id`-named encrypted vault called `Secret`.
fn id_vault_repo() -> Repo {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["vault", "add", "Secret", "--encrypted", "--id-naming"])),
        0
    );
    let listed = repo.run(&["key", "list", "--vault", "Private", "--json"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let recipient = rows[0]["recipients"][0]
        .as_str()
        .expect("recipient")
        .to_string();
    assert_eq!(
        code(&repo.run(&["key", "add", &recipient, "--vault", "Secret"])),
        0
    );
    repo
}

fn doc_with_id(id: &str, title: &str) -> String {
    format!("---\nid: {id}\ntitle: {title}\ncreated: 2026-01-01T00:00:00Z\n---\nbody\n")
}

/// The payload names directly under a vault, ULIDs without the suffix.
fn payload_ids(repo: &Repo, vault: &str) -> Vec<String> {
    files_in(&repo.root.join(vault))
        .into_iter()
        .filter_map(|name| name.strip_suffix(".age").map(String::from))
        .collect()
}

#[test]
fn a_doc_imported_into_an_id_vault_is_named_by_its_own_id() {
    // §7.2: the on-disk name MUST equal the document's `id`. Import used to
    // give the payload a fresh id while keeping the Doc's own inside it, and
    // `verify` cannot see the difference because it never decrypts.
    let repo = id_vault_repo();
    let own = "01jb8x4k7m2n3p5q6r9s0t1v2w";
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("doc.md"), doc_with_id(own, "has an id")).expect("write");

    let imported = repo.run(&["import", &source.to_string_lossy(), "Secret"]);
    assert_eq!(code(&imported), 0, "{}{}", out(&imported), err(&imported));

    assert_eq!(payload_ids(&repo, "Secret"), [own]);
    // And it is the same document: the id inside is the one outside.
    let shown = repo.run(&["decrypt", &format!("Secret/{own}.age")]);
    assert!(
        out(&shown).contains(&format!("id: {own}")),
        "{}",
        out(&shown)
    );
}

#[test]
fn a_promoted_file_is_named_by_the_id_it_was_given() {
    let repo = id_vault_repo();
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("plain.md"), "# Plain\n").expect("write");
    std::fs::write(source.join("data.csv"), "a,b\n").expect("write");

    assert_eq!(
        code(&repo.run(&["import", &source.to_string_lossy(), "Secret"])),
        0
    );

    let ids = payload_ids(&repo, "Secret");
    assert_eq!(ids.len(), 2, "{ids:?}");
    let mut found = 0;
    for id in &ids {
        let shown = out(&repo.run(&["decrypt", &format!("Secret/{id}.age")]));
        // A Markdown file's name is its frontmatter id; a file with no
        // frontmatter has nothing to disagree with.
        if shown.contains("# Plain") {
            assert!(shown.contains(&format!("id: {id}")), "{shown}");
            found += 1;
        }
    }
    assert_eq!(found, 1);
}

#[test]
fn export_then_import_keeps_an_id_vaults_names() {
    // The case this matters most: moving a vault's documents through
    // `export` and `import` must not rename every payload.
    let repo = id_vault_repo();
    let own = "01jb8x4k7m2n3p5q6r9s0t1v2w";
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("doc.md"), doc_with_id(own, "round trip")).expect("write");
    assert_eq!(
        code(&repo.run(&["import", &source.to_string_lossy(), "Secret"])),
        0
    );

    let exported = repo.outside("exported");
    assert_eq!(
        code(&repo.run(&["export", "Secret", &exported.to_string_lossy()])),
        0
    );
    assert_eq!(
        code(&repo.run(&["vault", "add", "Copy", "--encrypted", "--id-naming"])),
        0
    );
    let listed = repo.run(&["key", "list", "--vault", "Private", "--json"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let recipient = rows[0]["recipients"][0].as_str().expect("key").to_string();
    assert_eq!(
        code(&repo.run(&["key", "add", &recipient, "--vault", "Copy"])),
        0
    );
    assert_eq!(
        code(&repo.run(&["import", &exported.to_string_lossy(), "Copy"])),
        0
    );

    assert_eq!(payload_ids(&repo, "Copy"), [own]);
}

#[test]
fn two_files_with_one_id_import_nothing() {
    let repo = id_vault_repo();
    let own = "01jb8x4k7m2n3p5q6r9s0t1v2w";
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("a.md"), doc_with_id(own, "a")).expect("write");
    std::fs::write(source.join("b.md"), doc_with_id(own, "b")).expect("write");

    let imported = repo.run(&["import", &source.to_string_lossy(), "Secret"]);
    assert_eq!(code(&imported), 2, "{}{}", out(&imported), err(&imported));
    assert!(
        err(&imported).contains("another file"),
        "{}",
        err(&imported)
    );
    assert!(payload_ids(&repo, "Secret").is_empty(), "nothing written");
}

#[test]
fn a_doc_whose_id_is_already_stored_is_not_written_over() {
    let repo = id_vault_repo();
    let own = "01jb8x4k7m2n3p5q6r9s0t1v2w";
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("doc.md"), doc_with_id(own, "first")).expect("write");
    assert_eq!(
        code(&repo.run(&["import", &source.to_string_lossy(), "Secret"])),
        0
    );
    let before = std::fs::read(repo.root.join(format!("Secret/{own}.age"))).expect("read");

    let again = repo.run(&["import", &source.to_string_lossy(), "Secret"]);
    assert_eq!(code(&again), 2, "{}{}", out(&again), err(&again));
    assert!(err(&again).contains("already exists"), "{}", err(&again));
    assert_eq!(
        std::fs::read(repo.root.join(format!("Secret/{own}.age"))).expect("read"),
        before
    );
}

// --- Refusals -------------------------------------------------------------

/// Invariant 1: a bulk decrypt is the one place this could do real damage.
#[test]
fn export_refuses_to_write_into_the_repository() {
    let repo = repo();
    assert_eq!(code(&repo.run(&["new", "Private/a.md", "--no-edit"])), 0);

    for destination in ["Private/exported", "Public/exported", "exported"] {
        let path = repo.root.join(destination);
        let refused = repo.run(&["export", "Private", &path.to_string_lossy()]);
        assert_eq!(code(&refused), 2, "{destination} was allowed");
        assert!(
            err(&refused).contains("inside the repository"),
            "{}",
            err(&refused)
        );
        assert!(!path.exists(), "{destination} was created anyway");
    }
}

#[test]
fn export_never_writes_over_existing_files() {
    let repo = repo();
    let destination = repo.outside("exported");
    std::fs::create_dir_all(&destination).expect("create");
    std::fs::write(destination.join("mine.md"), "my work").expect("write");

    let refused = repo.run(&["export", "Public", &destination.to_string_lossy()]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("not empty"), "{}", err(&refused));
    assert_eq!(
        std::fs::read_to_string(destination.join("mine.md")).expect("read"),
        "my work"
    );
}

#[test]
fn import_refuses_a_name_the_path_rules_forbid() {
    // §5, applied before anything is written: a partial import is worse
    // than a refused one.
    let repo = repo();
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("fine.md"), "# Fine\n").expect("write");
    std::fs::write(source.join("CON.md"), "# Device\n").expect("write");

    let refused = repo.run(&["import", &source.to_string_lossy(), "Public"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("E503"), "{}", err(&refused));
    assert!(
        err(&refused).contains("nothing was imported"),
        "{}",
        err(&refused)
    );
    // Not even the acceptable one.
    assert!(!repo.root.join("Public/fine.md").exists());
}

#[test]
fn import_never_writes_over_an_existing_document() {
    let repo = repo();
    assert_eq!(code(&repo.run(&["new", "Public/notes.md", "--no-edit"])), 0);
    let before = std::fs::read_to_string(repo.root.join("Public/notes.md")).expect("read");

    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("notes.md"), "# Different\n").expect("write");

    let refused = repo.run(&["import", &source.to_string_lossy(), "Public"]);
    assert_eq!(code(&refused), 2);
    assert!(
        err(&refused).contains("already exists"),
        "{}",
        err(&refused)
    );
    assert_eq!(
        std::fs::read_to_string(repo.root.join("Public/notes.md")).expect("read"),
        before
    );
}

#[test]
fn import_from_inside_the_repository_is_refused() {
    let repo = repo();
    let refused = repo.run(&[
        "import",
        &repo.root.join("Public").to_string_lossy(),
        "Private",
    ]);
    assert_eq!(code(&refused), 2);
    assert!(
        err(&refused).contains("inside the repository"),
        "{}",
        err(&refused)
    );
}

#[test]
fn import_into_a_vault_with_no_keys_is_refused() {
    let repo = repo();
    std::fs::write(repo.root.join("Private/recipients.txt"), "# none\n").expect("write");
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("a.md"), "# A\n").expect("write");

    let refused = repo.run(&["import", &source.to_string_lossy(), "Private"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("no recipients"), "{}", err(&refused));
}

#[test]
fn an_unknown_vault_is_refused_by_both() {
    let repo = repo();
    let destination = repo.outside("exported");
    let refused = repo.run(&["export", "Nope", &destination.to_string_lossy()]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("vault list"), "{}", err(&refused));

    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    let refused = repo.run(&["import", &source.to_string_lossy(), "Nope"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("vault list"), "{}", err(&refused));
}

#[test]
fn a_newer_repository_is_never_imported_into() {
    // Invariant 4. Export is a read, so it stays allowed.
    let repo = repo();
    let manifest = repo.root.join("fjord.json");
    let contents = std::fs::read_to_string(&manifest).expect("read");
    std::fs::write(&manifest, contents.replace("\"fjord\": 1", "\"fjord\": 2")).expect("write");

    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    std::fs::write(source.join("a.md"), "# A\n").expect("write");
    let refused = repo.run(&["import", &source.to_string_lossy(), "Public"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("version 2"), "{}", err(&refused));

    let destination = repo.outside("exported");
    let exported = repo.run(&["export", "Public", &destination.to_string_lossy()]);
    assert_eq!(
        code(&exported),
        0,
        "reading should still be allowed: {}",
        err(&exported)
    );
}

#[test]
fn an_empty_directory_is_not_an_error() {
    let repo = repo();
    let source = repo.outside("incoming");
    std::fs::create_dir_all(&source).expect("create");
    let imported = repo.run(&["import", &source.to_string_lossy(), "Public"]);
    assert_eq!(code(&imported), 0, "{}", err(&imported));
    assert!(
        out(&imported).contains("nothing to import"),
        "{}",
        out(&imported)
    );
}

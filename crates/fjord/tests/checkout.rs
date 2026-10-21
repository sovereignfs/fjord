// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord decrypt <vault>` and `fjord encrypt <vault>`: a checkout. Spec §6.6.
//!
//! The workflow under test is the one a person actually has: decrypt a vault
//! in place, work on it with ordinary tools, check it back in, sync. Every
//! test runs the real binary against a real repository, because the thing
//! being protected is what ends up on disk and in git.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
    recipient: String,
}

impl Repo {
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("TMPDIR", self.temp.path())
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .env_remove("EDITOR")
            .env_remove("VISUAL");
        command
    }

    fn fjord(&self, arguments: &[&str]) -> Output {
        self.command().args(arguments).output().expect("run fjord")
    }

    fn fjord_ok(&self, arguments: &[&str]) -> String {
        let output = self.fjord(arguments);
        assert_eq!(
            code(&output),
            0,
            "fjord {arguments:?}\n{}{}",
            out(&output),
            err(&output)
        );
        out(&output)
    }

    fn git(&self, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(arguments)
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .expect("run git");
        assert_eq!(code(&output), 0, "git {arguments:?}: {}", err(&output));
        out(&output)
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.path(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, text).expect("write");
    }

    fn read(&self, relative: &str) -> String {
        std::fs::read_to_string(self.path(relative)).expect("read")
    }

    fn bytes(&self, relative: &str) -> Vec<u8> {
        std::fs::read(self.path(relative)).expect("read")
    }

    fn exists(&self, relative: &str) -> bool {
        self.path(relative).exists()
    }

    /// Every file under a vault, relative to the repository, sorted.
    fn files(&self, vault: &str) -> Vec<String> {
        fn walk(base: &Path, relative: String, found: &mut Vec<String>) {
            for entry in std::fs::read_dir(base.join(&relative)).expect("read_dir") {
                let entry = entry.expect("entry");
                let name = entry.file_name().to_string_lossy().to_string();
                let child = format!("{relative}/{name}");
                if entry.file_type().expect("type").is_dir() {
                    walk(base, child, found);
                } else {
                    found.push(child);
                }
            }
        }
        let mut found = Vec::new();
        walk(&self.root, vault.to_string(), &mut found);
        found.sort();
        found
    }

    fn commits(&self) -> usize {
        self.git(&["rev-list", "--count", "HEAD"])
            .trim()
            .parse()
            .expect("count")
    }

    /// The plaintext of a document, read back through fjord.
    fn secret(&self, payload: &str) -> String {
        self.fjord_ok(&["decrypt", payload])
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

/// A repository with an encrypted `Private` vault holding `plan.md`,
/// `Inbox/todo.md` and `gone.md`, everything committed.
fn repo() -> Repo {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let config = temp.path().join("config");

    let generated = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &config)
        .current_dir(temp.path())
        .output()
        .expect("key new");
    assert_eq!(code(&generated), 0, "{}", err(&generated));
    let report: serde_json::Value = serde_json::from_slice(&generated.stdout).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();

    let repo = Repo {
        temp,
        root,
        config,
        recipient,
    };
    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &repo.root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(code(&init), 0, "{}", err(&init));

    let recipient = repo.recipient.clone();
    repo.fjord_ok(&["key", "add", &recipient, "--vault", "Private"]);
    repo.fjord_ok(&["new", "Private/plan.md", "--no-edit"]);
    repo.fjord_ok(&["new", "Private/Inbox/todo.md", "--no-edit"]);
    repo.fjord_ok(&["new", "Private/gone.md", "--no-edit"]);
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-qm", "Start"]);
    repo
}

/// An `id`-named encrypted vault (spec §7.2) with one document.
fn id_repo() -> Repo {
    let repo = repo();
    let recipient = repo.recipient.clone();
    repo.fjord_ok(&[
        "vault",
        "add",
        "Vault",
        "--encrypted",
        "--id-naming",
        "--recipient",
        &recipient,
    ]);
    repo.fjord_ok(&["new", "Vault/notes.md", "--no-edit"]);
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-qm", "Add Vault"]);
    repo
}

// --- The workflow ------------------------------------------------------------

#[test]
fn decrypt_a_vault_edit_it_check_it_in_and_sync() {
    let repo = repo();

    // Decrypt: the plaintext sits beside the payload, where the editor expects it.
    let started = repo.fjord_ok(&["decrypt", "Private"]);
    assert!(started.contains("decrypted 3 documents"), "{started}");
    assert!(started.contains("fjord encrypt Private"), "{started}");
    for name in ["plan.md", "Inbox/todo.md", "gone.md"] {
        assert!(repo.exists(&format!("Private/{name}")), "{name}");
        assert!(repo.exists(&format!("Private/{name}.age")), "{name}.age");
    }
    assert!(repo.read("Private/plan.md").contains("title: plan"));

    // Work: edit one, add one, delete one.
    repo.write(
        "Private/plan.md",
        &format!("{}\nedited in place\n", repo.read("Private/plan.md")),
    );
    repo.write("Private/fresh.txt", "brand new\n");
    std::fs::remove_file(repo.path("Private/gone.md")).expect("remove");

    // Sync is refused while the vault is out, and nothing is committed.
    let before = repo.commits();
    let blocked = repo.fjord(&["sync"]);
    assert_eq!(code(&blocked), 1, "{}{}", out(&blocked), err(&blocked));
    assert!(
        err(&blocked).contains("Private vault is checked out"),
        "{}",
        err(&blocked)
    );
    assert!(
        err(&blocked).contains("fjord encrypt Private"),
        "{}",
        err(&blocked)
    );
    assert_eq!(repo.commits(), before);

    // Check in.
    let finished = repo.fjord_ok(&["encrypt", "Private", "--yes"]);
    assert!(finished.contains("plan.md"), "{finished}");
    assert!(finished.contains("fresh.txt"), "{finished}");
    assert!(finished.contains("gone.md"), "{finished}");
    assert!(finished.contains("encrypted again"), "{finished}");

    // Nothing is left in the clear, and the edits made it in.
    assert_eq!(
        repo.files("Private"),
        [
            "Private/.gitignore",
            "Private/Inbox/todo.md.age",
            "Private/fjord.vault.json",
            "Private/fresh.txt.age",
            "Private/plan.md.age",
            "Private/recipients.txt",
        ]
    );
    assert!(repo
        .secret("Private/plan.md.age")
        .contains("edited in place"));
    assert_eq!(repo.secret("Private/fresh.txt.age"), "brand new\n");
    assert_eq!(repo.fjord(&["verify"]).status.code(), Some(0));

    // And sync works, committing ciphertext only.
    repo.fjord_ok(&["sync"]);
    let tracked = repo.git(&["ls-files", "Private"]);
    assert!(!tracked.contains("Private/plan.md\n"), "{tracked}");
    assert!(tracked.contains("Private/plan.md.age"), "{tracked}");
    assert!(tracked.contains("Private/fresh.txt.age"), "{tracked}");
    assert!(!tracked.contains("gone.md"), "{tracked}");
}

#[test]
fn an_untouched_document_keeps_its_payload_byte_for_byte() {
    // age output is non-deterministic, so re-encrypting an unchanged
    // document would write a different object that git cannot delta against.
    let repo = repo();
    let before = repo.bytes("Private/Inbox/todo.md.age");
    let edited_before = repo.bytes("Private/plan.md.age");

    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write("Private/plan.md", "replaced\n");
    repo.fjord_ok(&["encrypt", "Private", "--yes"]);

    assert_eq!(repo.bytes("Private/Inbox/todo.md.age"), before);
    assert_ne!(repo.bytes("Private/plan.md.age"), edited_before);
}

#[test]
fn checking_in_with_no_changes_rewrites_nothing_and_clears_the_plaintext() {
    let repo = repo();
    let payloads: Vec<Vec<u8>> = ["plan.md", "Inbox/todo.md", "gone.md"]
        .iter()
        .map(|name| repo.bytes(&format!("Private/{name}.age")))
        .collect();

    repo.fjord_ok(&["decrypt", "Private"]);
    let finished = repo.fjord_ok(&["encrypt", "Private"]);
    assert!(finished.contains("nothing changed"), "{finished}");

    for (name, before) in ["plan.md", "Inbox/todo.md", "gone.md"]
        .iter()
        .zip(&payloads)
    {
        assert_eq!(&repo.bytes(&format!("Private/{name}.age")), before);
        assert!(!repo.exists(&format!("Private/{name}")));
    }
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}

#[test]
fn the_decrypted_copies_are_not_visible_to_git() {
    // The guard .gitignore is what makes a checkout safe against a plain
    // `git add -A`, which Fjord does not control.
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write("Private/fresh.txt", "x\n");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
    repo.git(&["add", "-A"]);
    assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "");
}

#[cfg(unix)]
#[test]
fn decrypted_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    let mode = std::fs::metadata(repo.path("Private/plan.md"))
        .expect("metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o077, 0, "mode was {mode:o}");
}

// --- The commit guard, during a checkout ---------------------------------------

#[test]
fn every_committing_command_refuses_while_the_vault_is_out() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    let before = repo.commits();

    for arguments in [
        &["sync"][..],
        &["sync", "--no-push"][..],
        &["rekey", "Private", "--yes"][..],
        &["vault", "add", "Other", "--commit"][..],
    ] {
        let output = repo.fjord(arguments);
        assert_eq!(
            code(&output),
            1,
            "{arguments:?}\n{}{}",
            out(&output),
            err(&output)
        );
        assert!(
            err(&output).contains("checked out"),
            "{arguments:?}: {}",
            err(&output)
        );
    }
    assert_eq!(repo.commits(), before);
    assert!(!repo.exists("Other"), "vault add must create nothing");
}

#[test]
fn status_and_verify_say_the_vault_is_checked_out() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);

    let status = repo.fjord_ok(&["status"]);
    assert!(status.contains("Private is checked out"), "{status}");

    // `verify` still reports the files in the clear, because they are, and
    // explains that they are expected.
    let verify = repo.fjord(&["verify"]);
    assert_eq!(code(&verify), 1);
    assert!(out(&verify).contains("E201"), "{}", out(&verify));
    assert!(
        out(&verify).contains("Private is checked out"),
        "{}",
        out(&verify)
    );

    let json: serde_json::Value =
        serde_json::from_str(&repo.fjord_ok(&["status", "--json"])).expect("json");
    assert_eq!(json["checkedOut"], serde_json::json!(["Private"]));
}

#[test]
fn open_refuses_a_document_in_a_checked_out_vault() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    let output = repo.fjord(&["open", "Private/plan.md", "--editor", "true"]);
    assert_eq!(code(&output), 2, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("checked out"), "{}", err(&output));
}

// --- Deletions -----------------------------------------------------------------

#[test]
fn removing_payloads_needs_confirmation_and_refusing_changes_nothing() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    std::fs::remove_file(repo.path("Private/gone.md")).expect("remove");
    repo.write("Private/plan.md", "edited\n");
    let payload = repo.bytes("Private/gone.md.age");

    let refused = repo.fjord(&["--no-input", "encrypt", "Private"]);
    assert_eq!(code(&refused), 2, "{}{}", out(&refused), err(&refused));
    assert!(err(&refused).contains("--yes"), "{}", err(&refused));

    // Nothing at all happened: still checked out, payload intact, the
    // edited file still in the clear.
    assert_eq!(repo.bytes("Private/gone.md.age"), payload);
    assert_eq!(repo.read("Private/plan.md"), "edited\n");
    assert_eq!(code(&repo.fjord(&["sync"])), 1);

    repo.fjord_ok(&["encrypt", "Private", "--yes"]);
    assert!(!repo.exists("Private/gone.md.age"));
}

#[test]
fn a_dry_run_changes_nothing() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    std::fs::remove_file(repo.path("Private/gone.md")).expect("remove");
    repo.write("Private/fresh.txt", "x\n");
    let files = repo.files("Private");

    let planned = repo.fjord_ok(&["encrypt", "Private", "--dry-run"]);
    assert!(planned.contains("fresh.txt"), "{planned}");
    assert!(planned.contains("gone.md"), "{planned}");
    assert!(planned.contains("dry run"), "{planned}");

    assert_eq!(repo.files("Private"), files);
    assert_eq!(code(&repo.fjord(&["sync"])), 1, "still checked out");
}

#[test]
fn editor_and_system_files_are_removed_not_encrypted() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write("Private/.DS_Store", "junk");
    repo.write("Private/plan.md~", "backup");
    repo.write("Private/.plan.md.swp", "swap");

    repo.fjord_ok(&["encrypt", "Private"]);

    assert!(!repo.exists("Private/.DS_Store"));
    assert!(!repo.exists("Private/plan.md~"));
    assert!(!repo
        .files("Private")
        .iter()
        .any(|f| f.ends_with(".DS_Store.age")));
    assert_eq!(repo.fjord(&["verify"]).status.code(), Some(0));
}

// --- Discard --------------------------------------------------------------------

#[test]
fn discard_throws_the_copies_away_and_leaves_the_payloads() {
    let repo = repo();
    let payload = repo.bytes("Private/plan.md.age");
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write("Private/plan.md", "edits I do not want\n");

    let refused = repo.fjord(&["--no-input", "encrypt", "Private", "--discard"]);
    assert_eq!(code(&refused), 2, "{}{}", out(&refused), err(&refused));
    assert!(
        repo.exists("Private/plan.md"),
        "nothing happens unconfirmed"
    );

    repo.fjord_ok(&["encrypt", "Private", "--discard", "--yes"]);
    assert!(!repo.exists("Private/plan.md"));
    assert_eq!(repo.bytes("Private/plan.md.age"), payload);
    repo.fjord_ok(&["sync"]);
}

// --- Refusals -------------------------------------------------------------------

#[test]
fn a_payload_that_changed_underneath_is_never_overwritten() {
    // Invariant 5, and spec §6.6 (7): somebody else's version survives.
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write("Private/plan.md", "my edit\n");

    // Someone re-encrypts the same document while it is out.
    let other = repo.path("Private/plan.md.age");
    let mut changed = std::fs::read(&other).expect("read");
    changed.push(0);
    std::fs::write(&other, &changed).expect("write");

    let output = repo.fjord(&["encrypt", "Private", "--yes"]);
    assert_eq!(code(&output), 2, "{}{}", out(&output), err(&output));
    assert!(
        err(&output).contains("plan.md.age changed"),
        "{}",
        err(&output)
    );
    assert_eq!(
        repo.bytes("Private/plan.md.age"),
        changed,
        "theirs untouched"
    );
    assert_eq!(repo.read("Private/plan.md"), "my edit\n", "mine untouched");
}

#[test]
fn encrypt_needs_a_checkout_and_decrypt_cannot_nest() {
    let repo = repo();

    let not_out = repo.fjord(&["encrypt", "Private"]);
    assert_eq!(code(&not_out), 2);
    assert!(
        err(&not_out).contains("not checked out"),
        "{}",
        err(&not_out)
    );

    repo.fjord_ok(&["decrypt", "Private"]);
    let twice = repo.fjord(&["decrypt", "Private"]);
    assert_eq!(code(&twice), 2);
    assert!(
        err(&twice).contains("already checked out"),
        "{}",
        err(&twice)
    );
}

#[test]
fn a_plaintext_vault_has_no_checkout() {
    let repo = repo();
    let output = repo.fjord(&["decrypt", "Public"]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("not encrypted"), "{}", err(&output));
}

#[test]
fn a_missing_guard_refuses_a_checkout() {
    let repo = repo();
    repo.git(&["rm", "-q", "Private/.gitignore"]);
    let output = repo.fjord(&["decrypt", "Private"]);
    assert_eq!(code(&output), 2, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("E208"), "{}", err(&output));
    assert!(!repo.exists("Private/plan.md"), "nothing was decrypted");
}

#[test]
fn a_vault_already_holding_plaintext_refuses_a_checkout() {
    let repo = repo();
    repo.write("Private/stray.md", "in the clear\n");
    let output = repo.fjord(&["decrypt", "Private"]);
    assert_eq!(code(&output), 2, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("stray.md"), "{}", err(&output));
    assert!(!repo.exists("Private/plan.md"));
}

#[test]
fn without_a_usable_identity_nothing_is_decrypted() {
    let repo = repo();
    std::fs::remove_file(repo.config.join("identity.txt")).expect("remove identity");
    let output = repo.fjord(&["decrypt", "Private"]);
    assert_ne!(code(&output), 0);
    assert!(!repo.exists("Private/plan.md"), "nothing was decrypted");
    assert_eq!(
        code(&repo.fjord(&["sync"])),
        0,
        "and no checkout was left behind"
    );
}

#[test]
fn single_file_flags_are_refused_for_a_vault_and_the_reverse() {
    let repo = repo();
    let keep = repo.fjord(&["encrypt", "Private", "--keep"]);
    assert_eq!(code(&keep), 2);

    let out_flag = repo.fjord(&["decrypt", "Private", "--out", "/tmp/x"]);
    assert_eq!(code(&out_flag), 2);

    let yes_on_file = repo.fjord(&["encrypt", "Private/plan.md", "--yes"]);
    assert_eq!(code(&yes_on_file), 2);
}

#[test]
fn an_interrupted_decrypt_is_never_mistaken_for_deletions() {
    // `decrypt` records the checkout before writing the first file, so a
    // crash leaves a record naming files that were never written. Checking
    // that in would offer to delete their payloads.
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);

    // Put the record back into the state a crash would have left it in.
    let directory = repo.path(".fjord/local/checkouts");
    let record = std::fs::read_dir(&directory)
        .expect("read_dir")
        .next()
        .expect("a record")
        .expect("entry")
        .path();
    let text = std::fs::read_to_string(&record).expect("read");
    assert!(text.contains("\"complete\": true"), "{text}");
    std::fs::write(
        &record,
        text.replace("\"complete\": true", "\"complete\": false"),
    )
    .expect("write");
    std::fs::remove_file(repo.path("Private/gone.md")).expect("remove");
    let payload = repo.bytes("Private/gone.md.age");

    let output = repo.fjord(&["encrypt", "Private", "--yes"]);
    assert_eq!(code(&output), 2, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("interrupted"), "{}", err(&output));
    assert_eq!(
        repo.bytes("Private/gone.md.age"),
        payload,
        "payload untouched"
    );

    // Still guarded, and still recoverable.
    assert_eq!(code(&repo.fjord(&["sync"])), 1);
    repo.fjord_ok(&["encrypt", "Private", "--discard", "--yes"]);
    repo.fjord_ok(&["sync"]);
    assert!(repo.secret("Private/gone.md.age").contains("title: gone"));
}

#[test]
fn a_directory_that_was_empty_before_is_left_alone() {
    let repo = repo();
    std::fs::create_dir_all(repo.path("Private/Empty")).expect("mkdir");
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.fjord_ok(&["encrypt", "Private"]);
    assert!(repo.path("Private/Empty").is_dir());
}

#[test]
fn a_directory_check_in_emptied_is_removed() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write("Private/Draft/idea.txt", "x\n");
    repo.fjord_ok(&["encrypt", "Private"]);
    // The payload lives there now, so the directory stays.
    assert!(repo.exists("Private/Draft/idea.txt.age"));

    repo.fjord_ok(&["decrypt", "Private"]);
    std::fs::remove_file(repo.path("Private/Draft/idea.txt")).expect("remove");
    repo.fjord_ok(&["encrypt", "Private", "--yes"]);
    assert!(!repo.exists("Private/Draft"), "{:?}", repo.files("Private"));
}

// --- Names ----------------------------------------------------------------------

#[test]
fn a_file_name_with_spaces_and_unicode_round_trips() {
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write("Private/Meeting notes — café.txt", "bonjour\n");
    repo.fjord_ok(&["encrypt", "Private"]);
    assert_eq!(
        repo.secret("Private/Meeting notes — café.txt.age"),
        "bonjour\n"
    );
}

#[test]
fn a_new_file_cannot_take_the_name_of_an_existing_payload() {
    // `fjord new` made notes.md.age during the checkout, so it is not in the
    // record; a decrypted file of the same name must not replace it.
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.fjord_ok(&["new", "Private/notes.md", "--no-edit"]);
    repo.write("Private/notes.md", "clobber\n");
    let before = repo.bytes("Private/notes.md.age");

    let output = repo.fjord(&["encrypt", "Private", "--yes"]);
    assert_eq!(code(&output), 2, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("already exists"), "{}", err(&output));
    assert_eq!(repo.bytes("Private/notes.md.age"), before);
    assert_eq!(repo.read("Private/notes.md"), "clobber\n");
}

// --- id-named vaults ---------------------------------------------------------------

#[test]
fn an_id_vault_decrypts_to_real_names_and_a_rename_edits_the_payload_in_place() {
    let repo = id_repo();
    let payload = repo
        .files("Vault")
        .into_iter()
        .find(|f| f.ends_with(".age"))
        .expect("payload");

    repo.fjord_ok(&["decrypt", "Vault"]);
    assert!(
        repo.exists("Vault/notes.md"),
        "the real name, from the container"
    );

    // Rename it in the editor, and edit it.
    let text = repo.read("Vault/notes.md");
    std::fs::remove_file(repo.path("Vault/notes.md")).expect("remove");
    repo.write("Vault/renamed.md", &format!("{text}\nrenamed\n"));

    repo.fjord_ok(&["encrypt", "Vault", "--yes"]);

    // §7.2: the on-disk name is the document's id, so a rename is a
    // modification of the same file, not a delete and an add.
    let payloads: Vec<String> = repo
        .files("Vault")
        .into_iter()
        .filter(|f| f.ends_with(".age"))
        .collect();
    assert_eq!(
        payloads,
        std::slice::from_ref(&payload),
        "one payload, same name"
    );
    assert!(repo.secret(&payload).contains("renamed"));
    assert_eq!(repo.fjord(&["verify"]).status.code(), Some(0));
}

#[test]
fn an_id_vault_names_a_new_document_by_its_own_id() {
    let repo = id_repo();
    repo.fjord_ok(&["decrypt", "Vault"]);
    repo.write(
        "Vault/fresh.md",
        "---\nid: 01jb8x4k7m2n3p5q6r9s0t1v2w\ntitle: fresh\n---\nhello\n",
    );
    repo.fjord_ok(&["encrypt", "Vault"]);
    assert!(
        repo.exists("Vault/01jb8x4k7m2n3p5q6r9s0t1v2w.age"),
        "{:?}",
        repo.files("Vault")
    );
    assert_eq!(repo.fjord(&["verify"]).status.code(), Some(0));
}

// --- Interop ------------------------------------------------------------------------

#[test]
fn the_reference_age_binary_reads_what_check_in_wrote() {
    // The format's promise: `age -d` alone recovers a file.
    let available = Command::new("age")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !available {
        eprintln!("skipped: the age binary is not installed");
        return;
    }
    let repo = repo();
    repo.fjord_ok(&["decrypt", "Private"]);
    repo.write(
        "Private/fresh.txt",
        "read by the reference implementation\n",
    );
    repo.fjord_ok(&["encrypt", "Private"]);

    let output = Command::new("age")
        .args(["-d", "-i"])
        .arg(repo.config.join("identity.txt"))
        .arg(repo.path("Private/fresh.txt.age"))
        .output()
        .expect("age");
    assert_eq!(code(&output), 0, "{}", err(&output));
    assert_eq!(out(&output), "read by the reference implementation\n");
}

// --- Machine output ------------------------------------------------------------------

#[test]
fn json_reports_both_directions() {
    let repo = repo();
    let started: serde_json::Value =
        serde_json::from_str(&repo.fjord_ok(&["decrypt", "Private", "--json"])).expect("json");
    assert_eq!(started["vault"], "Private");
    assert_eq!(started["files"].as_array().expect("files").len(), 3);

    repo.write("Private/fresh.txt", "x\n");
    let planned: serde_json::Value =
        serde_json::from_str(&repo.fjord_ok(&["encrypt", "Private", "--dry-run", "--json"]))
            .expect("json");
    assert_eq!(planned["dryRun"], true);
    assert_eq!(planned["added"], serde_json::json!(["fresh.txt"]));

    let finished: serde_json::Value =
        serde_json::from_str(&repo.fjord_ok(&["encrypt", "Private", "--json"])).expect("json");
    assert_eq!(finished["dryRun"], false);
}

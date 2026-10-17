// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord key`, `fjord encrypt` and `fjord decrypt`.
//!
//! Two of these tests exist because the specification uses the word MUST
//! about what a user is told, not about what bytes are written:
//! `revocation_is_stated_plainly` (§11.4) and
//! `an_identity_is_never_written_inside_a_repository` (§11.3). A change
//! that quietly softened either would be a conformance failure that no
//! amount of round-tripping would catch.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}

impl Repo {
    /// Run `fjord` against this repository.
    fn run(&self, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY");
        command.output().expect("run fjord")
    }

    /// Run `fjord` with no repository argument, for `key new`.
    fn run_bare(&self, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env_remove("FJORD_IDENTITY")
            // Outside any repository, so `key new`'s §11.3 check has
            // nothing to object to.
            .current_dir(self._temp.path());
        command.output().expect("run fjord")
    }

    fn identity(&self) -> PathBuf {
        self.config.join("identity.txt")
    }

    fn recipients(&self) -> String {
        std::fs::read_to_string(self.root.join("Private/recipients.txt")).expect("read")
    }
}

fn repo() -> Repo {
    let temp = tempfile::tempdir().expect("temporary directory");
    let root = temp.path().join("repo");
    let config = temp.path().join("config");

    let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("run fjord init");
    assert_eq!(output.status.code(), Some(0), "init failed");

    Repo {
        _temp: temp,
        root,
        config,
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

/// Generate an identity and register it with `Private`.
fn with_key(repo: &Repo) -> String {
    let generated = repo.run_bare(&["key", "new", "--json"]);
    assert_eq!(code(&generated), 0, "key new: {}", err(&generated));
    let report: serde_json::Value = serde_json::from_str(&out(&generated)).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();

    let added = repo.run(&["key", "add", &recipient, "--vault", "Private"]);
    assert_eq!(code(&added), 0, "key add: {}", err(&added));
    recipient
}

// --- key new -------------------------------------------------------------

#[test]
fn key_new_writes_an_identity_and_prints_only_its_public_key() {
    let repo = repo();
    let output = repo.run_bare(&["key", "new"]);
    assert_eq!(code(&output), 0, "{}", err(&output));

    let identity = repo.identity();
    assert!(identity.is_file(), "no identity was written");
    let contents = std::fs::read_to_string(&identity).expect("read");
    assert!(contents.contains("AGE-SECRET-KEY-1"));

    // The secret must never reach a terminal: scrollback, CI logs, screen
    // shares. Only the public key is shown.
    let printed = out(&output);
    assert!(
        !printed.contains("AGE-SECRET-KEY-1"),
        "the secret key was printed:\n{printed}"
    );
    assert!(printed.contains("age1"), "the public key was not shown");
}

#[cfg(unix)]
#[test]
fn an_identity_is_written_readable_only_by_its_owner() {
    use std::os::unix::fs::MetadataExt;
    let repo = repo();
    assert_eq!(code(&repo.run_bare(&["key", "new"])), 0);
    let mode = std::fs::metadata(repo.identity()).expect("metadata").mode();
    assert_eq!(mode & 0o777, 0o600, "mode was {:o}", mode & 0o777);
}

/// Spec §11.3: an identity MUST NOT be stored in the repository it
/// decrypts.
#[test]
fn an_identity_is_never_written_inside_a_repository() {
    let repo = repo();
    let inside = repo.root.join("Private/identity.txt");
    let output = repo.run_bare(&["key", "new", "--out", &inside.to_string_lossy()]);

    assert_eq!(code(&output), 2, "{}", out(&output));
    assert!(err(&output).contains("§11.3"), "{}", err(&output));
    assert!(
        !inside.exists(),
        "an identity was written into the repository"
    );
}

#[test]
fn key_new_refuses_to_overwrite_an_identity() {
    let repo = repo();
    assert_eq!(code(&repo.run_bare(&["key", "new"])), 0);
    let first = std::fs::read_to_string(repo.identity()).expect("read");

    let again = repo.run_bare(&["key", "new"]);
    assert_eq!(code(&again), 2);
    assert!(err(&again).contains("already exists"), "{}", err(&again));
    // Overwriting would make every file encrypted to the old key
    // unreadable.
    assert_eq!(
        std::fs::read_to_string(repo.identity()).expect("read"),
        first
    );
}

// --- key add -------------------------------------------------------------

#[test]
fn adding_a_key_makes_the_repository_fully_clean() {
    let repo = repo();
    // Before: W602, the one warning a fresh repository carries.
    let before = repo.run(&["verify", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&out(&before)).expect("json");
    assert_eq!(report["counts"]["warnings"], serde_json::Value::from(1));

    with_key(&repo);

    let after = repo.run(&["verify", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&out(&after)).expect("json");
    assert_eq!(report["counts"]["errors"], serde_json::Value::from(0));
    assert_eq!(
        report["counts"]["warnings"],
        serde_json::Value::from(0),
        "a repository with a key should be completely clean: {}",
        out(&after)
    );
}

#[test]
fn adding_a_key_says_it_does_not_grant_access_to_existing_files() {
    // §6.2, and the most common misunderstanding about age.
    let repo = repo();
    let generated = repo.run_bare(&["key", "new", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&out(&generated)).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient");

    let added = repo.run(&["key", "add", recipient, "--vault", "Private"]);
    let printed = out(&added);
    assert!(
        printed.contains("does not grant access"),
        "the caveat was not stated:\n{printed}"
    );
    assert!(
        printed.contains("rekey"),
        "no remedy was offered:\n{printed}"
    );
}

#[test]
fn a_passphrase_recipient_is_refused() {
    let repo = repo();
    let output = repo.run(&["key", "add", "passphrase", "--vault", "Private"]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("§6.2"), "{}", err(&output));
    assert!(!repo.recipients().contains("passphrase"));
}

#[test]
fn a_malformed_recipient_is_refused() {
    let repo = repo();
    let output = repo.run(&["key", "add", "age1nonsense", "--vault", "Private"]);
    assert_eq!(code(&output), 2);
    assert!(!repo.recipients().contains("age1nonsense"));
}

#[test]
fn adding_the_same_key_twice_changes_nothing() {
    let repo = repo();
    let recipient = with_key(&repo);
    let before = repo.recipients();

    let again = repo.run(&["key", "add", &recipient, "--vault", "Private"]);
    assert_eq!(code(&again), 0);
    assert_eq!(repo.recipients(), before, "the key was added twice");
}

#[test]
fn a_plaintext_vault_has_no_recipients_to_manage() {
    let repo = repo();
    let generated = repo.run_bare(&["key", "new", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&out(&generated)).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient");

    let output = repo.run(&["key", "add", recipient, "--vault", "Public"]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("not encrypted"), "{}", err(&output));
}

#[test]
fn an_unknown_vault_is_refused() {
    let repo = repo();
    let output = repo.run(&["key", "list", "--vault", "Nonexistent"]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("no vault called"), "{}", err(&output));
}

// --- key list ------------------------------------------------------------

#[test]
fn key_list_reports_each_vault() {
    let repo = repo();
    let recipient = with_key(&repo);

    let listed = repo.run(&["key", "list"]);
    assert_eq!(code(&listed), 0);
    assert!(out(&listed).contains(&recipient));
    assert!(out(&listed).contains("Private"));

    let json = repo.run(&["key", "list", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&out(&json)).expect("json");
    let vaults = report.as_array().expect("array");
    assert_eq!(vaults.len(), 1, "only Private is encrypted");
    assert_eq!(vaults[0]["vault"], serde_json::Value::from("Private"));
    assert_eq!(
        vaults[0]["recipients"][0],
        serde_json::Value::from(recipient.as_str())
    );
}

// --- key remove ----------------------------------------------------------

/// Spec §11.4: clients MUST state plainly that this is not revocation.
/// This is an acceptance criterion for the milestone, not a nicety.
#[test]
fn revocation_is_stated_plainly() {
    let repo = repo();
    let recipient = with_key(&repo);

    let removed = repo.run(&["key", "remove", &recipient, "--vault", "Private"]);
    assert_eq!(code(&removed), 0, "{}", err(&removed));
    let printed = out(&removed);

    assert!(
        printed.contains("revokes nothing"),
        "§11.4 requires saying this is not revocation:\n{printed}"
    );
    assert!(
        printed.contains("permanently"),
        "§11.4: already-committed versions stay decryptable permanently:\n{printed}"
    );
    assert!(
        printed.contains("history"),
        "§11.4: the reason is that Git keeps history:\n{printed}"
    );
    assert!(
        printed.contains("new repository"),
        "§11.4: retiring a key means re-encrypting and rewriting history:\n{printed}"
    );

    assert!(
        !repo.recipients().contains(&recipient),
        "the key was not removed"
    );
}

#[test]
fn removing_the_last_key_warns_that_the_vault_is_now_unwritable() {
    let repo = repo();
    let recipient = with_key(&repo);
    let removed = repo.run(&["key", "remove", &recipient, "--vault", "Private"]);
    assert!(
        out(&removed).contains("nothing can be written"),
        "{}",
        out(&removed)
    );
}

#[test]
fn removing_a_key_that_is_not_there_is_refused() {
    let repo = repo();
    let output = repo.run(&[
        "key",
        "remove",
        "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
        "--vault",
        "Private",
    ]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("not a recipient"), "{}", err(&output));
}

// --- encrypt / decrypt ---------------------------------------------------

#[test]
fn encrypt_replaces_the_plaintext_and_decrypt_returns_it() {
    let repo = repo();
    with_key(&repo);

    let plaintext = "# Notes\n\nkeep this private\n";
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, plaintext).expect("write");

    let encrypted = repo.run(&["encrypt", &source.to_string_lossy()]);
    assert_eq!(code(&encrypted), 0, "{}", err(&encrypted));
    assert!(!source.exists(), "the plaintext survived");
    assert!(repo.root.join("Private/notes.md.age").is_file());

    // And the repository is still conforming — which it would not be if the
    // plaintext had been left behind (E201).
    assert_eq!(code(&repo.run(&["verify"])), 0);

    let decrypted = repo.run(&[
        "decrypt",
        &repo.root.join("Private/notes.md.age").to_string_lossy(),
    ]);
    assert_eq!(code(&decrypted), 0, "{}", err(&decrypted));
    assert_eq!(out(&decrypted), plaintext);
}

#[test]
fn keep_leaves_the_plaintext_and_says_so() {
    let repo = repo();
    with_key(&repo);
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, "text\n").expect("write");

    let encrypted = repo.run(&["encrypt", &source.to_string_lossy(), "--keep"]);
    assert_eq!(code(&encrypted), 0, "{}", err(&encrypted));
    assert!(source.exists());
    assert!(out(&encrypted).contains("E201"), "{}", out(&encrypted));

    // And verify agrees that this is now a problem.
    let report = repo.run(&["verify", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&out(&report)).expect("json");
    assert_eq!(
        report["diagnostics"][0]["code"],
        serde_json::Value::from("E201")
    );
}

#[test]
fn encrypting_to_a_vault_with_no_keys_is_refused() {
    // §6.2: refuse rather than store plaintext.
    let repo = repo();
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, "text\n").expect("write");

    let output = repo.run(&["encrypt", &source.to_string_lossy()]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("no recipients"), "{}", err(&output));
    assert!(source.exists(), "the plaintext must be left alone");
    assert!(!repo.root.join("Private/notes.md.age").exists());
}

#[test]
fn a_plaintext_vault_cannot_be_encrypted_into() {
    let repo = repo();
    with_key(&repo);
    let source = repo.root.join("Public/open.md");
    std::fs::write(&source, "text\n").expect("write");

    let output = repo.run(&["encrypt", &source.to_string_lossy()]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("not encrypted"), "{}", err(&output));
}

#[test]
fn encrypting_twice_is_refused_rather_than_destroying_the_payload() {
    let repo = repo();
    with_key(&repo);
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, "first\n").expect("write");
    assert_eq!(code(&repo.run(&["encrypt", &source.to_string_lossy()])), 0);

    let payload = repo.root.join("Private/notes.md.age");
    let before = std::fs::read(&payload).expect("read");

    std::fs::write(&source, "second\n").expect("write");
    let again = repo.run(&["encrypt", &source.to_string_lossy()]);
    assert_eq!(code(&again), 2);
    assert!(err(&again).contains("already exists"), "{}", err(&again));
    assert_eq!(std::fs::read(&payload).expect("read"), before);
}

/// Invariant 1: there is no invocation that writes plaintext into an
/// encrypted vault.
#[test]
fn decrypt_refuses_to_write_plaintext_into_an_encrypted_vault() {
    let repo = repo();
    with_key(&repo);
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, "text\n").expect("write");
    assert_eq!(code(&repo.run(&["encrypt", &source.to_string_lossy()])), 0);

    let payload = repo.root.join("Private/notes.md.age");
    let destination = repo.root.join("Private/leaked.md");
    let output = repo.run(&[
        "decrypt",
        &payload.to_string_lossy(),
        "-o",
        &destination.to_string_lossy(),
    ]);

    assert_eq!(code(&output), 2, "{}", out(&output));
    assert!(err(&output).contains("§6.5"), "{}", err(&output));
    assert!(
        !destination.exists(),
        "plaintext was written into the vault"
    );
}

#[test]
fn decrypt_can_write_outside_the_repository() {
    let repo = repo();
    with_key(&repo);
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, "recoverable\n").expect("write");
    assert_eq!(code(&repo.run(&["encrypt", &source.to_string_lossy()])), 0);

    let destination = repo._temp.path().join("restored.md");
    let output = repo.run(&[
        "decrypt",
        &repo.root.join("Private/notes.md.age").to_string_lossy(),
        "-o",
        &destination.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 0, "{}", err(&output));
    assert_eq!(
        std::fs::read_to_string(&destination).expect("read"),
        "recoverable\n"
    );
}

#[test]
fn decrypting_without_an_identity_explains_where_to_get_one() {
    let repo = repo();
    with_key(&repo);
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, "text\n").expect("write");
    assert_eq!(code(&repo.run(&["encrypt", &source.to_string_lossy()])), 0);

    // A config directory with no identity in it.
    let empty = repo._temp.path().join("empty-config");
    let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .arg("-C")
        .arg(&repo.root)
        .args(["decrypt"])
        .arg(repo.root.join("Private/notes.md.age"))
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &empty)
        .env_remove("FJORD_IDENTITY")
        .output()
        .expect("run fjord");

    assert_ne!(output.status.code(), Some(0));
    let message = String::from_utf8_lossy(&output.stderr);
    assert!(message.contains("key new"), "{message}");
    assert!(message.contains("--identity"), "{message}");
}

#[test]
fn an_identity_can_arrive_on_stdin() {
    // Spec §11.3 and the argv rule: a secret must never need to be a
    // command-line argument.
    use std::io::Write;
    use std::process::Stdio;

    let repo = repo();
    with_key(&repo);
    let source = repo.root.join("Private/notes.md");
    std::fs::write(&source, "from stdin\n").expect("write");
    assert_eq!(code(&repo.run(&["encrypt", &source.to_string_lossy()])), 0);

    let identity = std::fs::read_to_string(repo.identity()).expect("read");
    let mut child = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .arg("-C")
        .arg(&repo.root)
        .args(["--identity", "-", "decrypt"])
        .arg(repo.root.join("Private/notes.md.age"))
        .env("NO_COLOR", "1")
        .env_remove("FJORD_IDENTITY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fjord");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(identity.as_bytes())
        .expect("write identity");
    let output = child.wait_with_output().expect("output");

    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "from stdin\n");
}

/// `--help` promises these paths are relative to the repository root, and
/// `-C` is useless otherwise. Every test above passes absolute paths, which
/// is exactly how this went unnoticed until `open` was written.
#[test]
fn a_repository_relative_path_works() {
    let repo = repo();
    with_key(&repo);
    std::fs::write(repo.root.join("Private/notes.md"), "text\n").expect("write");

    let encrypted = repo.run(&["encrypt", "Private/notes.md"]);
    assert_eq!(code(&encrypted), 0, "{}", err(&encrypted));
    assert!(repo.root.join("Private/notes.md.age").is_file());

    let decrypted = repo.run(&["decrypt", "Private/notes.md.age"]);
    assert_eq!(code(&decrypted), 0, "{}", err(&decrypted));
    assert_eq!(out(&decrypted), "text\n");
}

#[test]
fn a_file_outside_the_repository_is_refused() {
    let repo = repo();
    with_key(&repo);
    let outside = repo._temp.path().join("elsewhere.md");
    std::fs::write(&outside, "text\n").expect("write");

    let output = repo.run(&["encrypt", &outside.to_string_lossy()]);
    assert_eq!(code(&output), 2);
    assert!(
        err(&output).contains("outside the repository"),
        "{}",
        err(&output)
    );
}

/// Keep `Path` referenced for the helpers above.
#[allow(dead_code)]
fn _path(_: &Path) {}

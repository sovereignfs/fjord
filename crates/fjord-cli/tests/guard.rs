// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The commit guard. Spec §6.5.
//!
//! §6.5 says a client MUST NOT commit an unencrypted document into an
//! encrypted vault, and leans on the vault's own `.gitignore` to make the
//! accident fail safe. Run against the real binary, that was only half
//! true: with the guard intact a stray plaintext file was silently skipped
//! by `fjord sync` (the edit simply was not saved, and the command said
//! "already up to date"), and with the guard missing `fjord sync` committed
//! and pushed it. These tests are that scenario, and the commands that
//! stage a whole vault share the hole.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}

fn command(repo: &Repo) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
    command
        .arg("-C")
        .arg(&repo.root)
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &repo.config)
        .env("TMPDIR", repo.temp.path())
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .env_remove("FJORD_IDENTITY")
        .env_remove("EDITOR")
        .env_remove("VISUAL");
    command
}

impl Repo {
    fn fjord(&self, arguments: &[&str]) -> Output {
        command(self).args(arguments).output().expect("run fjord")
    }

    fn git(&self, arguments: &[&str]) -> Output {
        Command::new("git")
            .current_dir(&self.root)
            .args(arguments)
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .expect("run git")
    }

    fn git_text(&self, arguments: &[&str]) -> String {
        let output = self.git(arguments);
        assert_eq!(
            output.status.code(),
            Some(0),
            "git {arguments:?}: {}",
            err(&output)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    fn commits(&self) -> usize {
        self.git_text(&["rev-list", "--count", "HEAD"])
            .trim()
            .parse()
            .expect("count")
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.root.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, text).expect("write");
    }
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("exit code")
}

fn err(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn out(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

/// A repository with a writable encrypted `Private` vault holding one
/// encrypted document, everything committed.
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
    assert_eq!(code(&init), 0, "{}", err(&init));

    let generated = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &repo.config)
        .current_dir(repo.temp.path())
        .output()
        .expect("key new");
    assert_eq!(code(&generated), 0, "{}", err(&generated));
    let report: serde_json::Value = serde_json::from_slice(&generated.stdout).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();

    let added = repo.fjord(&["key", "add", &recipient, "--vault", "Private"]);
    assert_eq!(code(&added), 0, "{}", err(&added));
    let created = repo.fjord(&["new", "Private/plan.md", "--no-edit"]);
    assert_eq!(code(&created), 0, "{}", err(&created));

    repo.git_text(&["add", "-A"]);
    repo.git_text(&["commit", "-qm", "Start"]);
    repo
}

/// What a stray decrypted file looks like: `age -d` into the vault, say.
fn leave_plaintext(repo: &Repo) {
    repo.write("Private/plan.md", "my unsaved secret edit\n");
}

fn remove_the_guard(repo: &Repo) {
    repo.git_text(&["rm", "-q", "Private/.gitignore"]);
    repo.git_text(&["commit", "-qm", "Remove the guard"]);
}

// --- sync ----------------------------------------------------------------

#[test]
fn sync_refuses_plaintext_in_an_encrypted_vault_and_says_so() {
    let repo = repo();
    leave_plaintext(&repo);
    let before = repo.commits();

    let output = repo.fjord(&["sync"]);

    // Before this, it printed "already up to date" and exited 0, and the
    // edit was in no commit.
    assert_eq!(code(&output), 1, "{}{}", out(&output), err(&output));
    let message = err(&output);
    assert!(message.contains("E201"), "{message}");
    assert!(message.contains("Private/plan.md"), "{message}");
    assert!(message.contains("Nothing was committed"), "{message}");
    assert_eq!(repo.commits(), before);
}

#[test]
fn sync_no_longer_publishes_plaintext_when_the_guard_is_missing() {
    // The reproduced leak: the vault's .gitignore deleted, a decrypted file
    // beside its payload, and `fjord sync` committing the lot.
    let repo = repo();
    remove_the_guard(&repo);
    leave_plaintext(&repo);
    let before = repo.commits();

    let output = repo.fjord(&["sync"]);

    assert_eq!(code(&output), 1, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("E208"), "{}", err(&output));
    assert_eq!(repo.commits(), before);
    assert!(
        repo.git_text(&["log", "--all", "--oneline", "--", "Private/plan.md"])
            .trim()
            .is_empty(),
        "the plaintext must not be in any commit"
    );
    assert!(
        !repo.git_text(&["ls-files"]).contains("Private/plan.md\n"),
        "the plaintext must not be tracked"
    );
}

#[test]
fn a_missing_guard_alone_is_enough_to_refuse() {
    // No plaintext yet: the next decrypted file would be committed rather
    // than skipped, and the spec makes the guard a MUST.
    let repo = repo();
    remove_the_guard(&repo);
    repo.write("Public/note.md", "an ordinary change\n");

    let output = repo.fjord(&["sync"]);

    assert_eq!(code(&output), 1, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("E208"), "{}", err(&output));
    assert!(err(&output).contains("Private"), "{}", err(&output));
}

#[test]
fn no_push_does_not_bypass_the_guard() {
    let repo = repo();
    leave_plaintext(&repo);
    let output = repo.fjord(&["sync", "--no-push"]);
    assert_eq!(code(&output), 1, "{}{}", out(&output), err(&output));
}

#[test]
fn sync_goes_ahead_once_the_vault_is_clean() {
    let repo = repo();
    leave_plaintext(&repo);
    assert_eq!(code(&repo.fjord(&["sync"])), 1);

    std::fs::remove_file(repo.root.join("Private/plan.md")).expect("remove");
    repo.write("Public/note.md", "an ordinary change\n");
    let before = repo.commits();

    let output = repo.fjord(&["sync"]);
    assert_eq!(code(&output), 0, "{}{}", out(&output), err(&output));
    assert_eq!(repo.commits(), before + 1);
}

#[test]
fn a_plaintext_vault_is_not_the_guards_business() {
    // Plain files in a plaintext vault are what it is for.
    let repo = repo();
    repo.write("Public/draft.txt", "not secret\n");
    let output = repo.fjord(&["sync"]);
    assert_eq!(code(&output), 0, "{}{}", out(&output), err(&output));
}

// --- the other commands that stage a whole vault -------------------------

#[test]
fn rekey_refuses_rather_than_staging_a_vault_holding_plaintext() {
    let repo = repo();
    remove_the_guard(&repo);
    leave_plaintext(&repo);
    let before = repo.commits();

    let output = repo.fjord(&["rekey", "Private", "--yes"]);

    assert_eq!(code(&output), 1, "{}{}", out(&output), err(&output));
    assert!(err(&output).contains("E201"), "{}", err(&output));
    assert_eq!(repo.commits(), before);
}

#[test]
fn vault_add_commit_refuses_while_another_vault_holds_plaintext() {
    let repo = repo();
    leave_plaintext(&repo);

    let output = repo.fjord(&["vault", "add", "Work", "--commit"]);

    assert_eq!(code(&output), 1, "{}{}", out(&output), err(&output));
    // Refused up front: nothing was created.
    assert!(!Path::new(&repo.root.join("Work")).exists());
}

#[test]
fn vault_add_without_commit_is_unaffected() {
    // Creating a vault commits nothing, so there is nothing to guard.
    let repo = repo();
    leave_plaintext(&repo);
    let output = repo.fjord(&["vault", "add", "Work"]);
    assert_eq!(code(&output), 0, "{}{}", out(&output), err(&output));
}

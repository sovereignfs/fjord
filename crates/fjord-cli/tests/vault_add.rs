// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord vault add`: creating a vault that is usable straight away, and
//! reporting what it did in a form a script can read.
//!
//! Before `--recipient`, an encrypted vault was born unwritable and the user
//! had to run `fjord key add` separately; before `--json` the command
//! ignored a global flag every other writing command honours.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    temp: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    /// Run as the identity in `config`.
    fn run_as(&self, config: &Path, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", config)
            .env("TMPDIR", self.temp.path())
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .env_remove("EDITOR");
        command.output().expect("run fjord")
    }

    fn run(&self, arguments: &[&str]) -> Output {
        self.run_as(&self.temp.path().join("none"), arguments)
    }

    fn manifest(&self) -> String {
        std::fs::read_to_string(self.root.join("fjord.json")).expect("read fjord.json")
    }
}

/// An identity in its own config directory, and its public key.
struct Identity {
    config: PathBuf,
    public: String,
}

fn identity(repo: &Repo, name: &str) -> Identity {
    let config = repo.temp.path().join(name);
    let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &config)
        .current_dir(repo.temp.path())
        .output()
        .expect("key new");
    assert_eq!(output.status.code(), Some(0), "{}", err(&output));
    let report: Value = serde_json::from_slice(&output.stdout).expect("json");
    Identity {
        config,
        public: report["recipient"].as_str().expect("recipient").to_string(),
    }
}

fn repo() -> Repo {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(output.status.code(), Some(0), "{}", err(&output));
    Repo { temp, root }
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

fn json(output: &Output) -> Value {
    match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => panic!("stdout is not JSON ({error}): {}", out(output)),
    }
}

// --- One step: a vault that is usable straight away -------------------------

/// The point of `--recipient`: no separate `key add`, no W602, and the first
/// document can be written at once.
#[test]
fn an_encrypted_vault_is_usable_the_moment_it_is_created() {
    let repo = repo();
    let me = identity(&repo, "me");

    let created = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--recipient",
        &me.public,
    ]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert!(out(&created).contains("1 recipient"), "{}", out(&created));
    // The hint to run `key add` would now be wrong, so it is not printed.
    assert!(
        !out(&created).contains("no recipients yet"),
        "{}",
        out(&created)
    );

    // Nothing to warn about: W602 is exactly what this removes.
    let verified = repo.run(&["verify", "--json"]);
    let report = json(&verified);
    let warnings: Vec<&Value> = report["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .filter(|d| d["path"].as_str().unwrap_or("").starts_with("Secret"))
        .collect();
    assert!(
        warnings.is_empty(),
        "the new vault has findings: {warnings:?}"
    );

    // And it can be written to and read back, with no `key add` in between.
    let new = repo.run_as(&me.config, &["new", "Secret/first.md", "--no-edit"]);
    assert_eq!(code(&new), 0, "{}", err(&new));
    let read = repo.run_as(&me.config, &["decrypt", "Secret/first.md.age"]);
    assert_eq!(code(&read), 0, "{}", err(&read));
    assert!(out(&read).contains("title: first"), "{}", out(&read));
}

#[test]
fn every_recipient_given_can_read_what_is_written() {
    let repo = repo();
    let laptop = identity(&repo, "laptop");
    let phone = identity(&repo, "phone");

    let created = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--recipient",
        &laptop.public,
        "--recipient",
        &phone.public,
    ]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert!(out(&created).contains("2 recipients"), "{}", out(&created));

    assert_eq!(
        code(&repo.run_as(&laptop.config, &["new", "Secret/a.md", "--no-edit"])),
        0
    );
    // §6.2: encrypted to all of them, so either can decrypt.
    for who in [&laptop, &phone] {
        let read = repo.run_as(&who.config, &["decrypt", "Secret/a.md.age"]);
        assert_eq!(code(&read), 0, "{}", err(&read));
    }
}

#[test]
fn the_same_key_twice_is_stored_once() {
    let repo = repo();
    let me = identity(&repo, "me");
    let created = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--recipient",
        &me.public,
        "--recipient",
        &me.public,
    ]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert!(out(&created).contains("1 recipient"), "{}", out(&created));

    let file = std::fs::read_to_string(repo.root.join("Secret/recipients.txt")).expect("read");
    assert_eq!(file.matches(&me.public).count(), 1, "{file}");
}

#[test]
fn an_id_vault_can_be_created_with_its_keys_too() {
    let repo = repo();
    let me = identity(&repo, "me");
    let created = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--id-naming",
        "--recipient",
        &me.public,
    ]);
    assert_eq!(code(&created), 0, "{}", err(&created));

    let new = repo.run_as(&me.config, &["new", "Secret/my notes.md", "--no-edit"]);
    assert_eq!(code(&new), 0, "{}", err(&new));
    let listed = repo.run_as(&me.config, &["ls", "Secret", "--long"]);
    assert!(out(&listed).contains("my notes.md"), "{}", out(&listed));
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn without_a_recipient_the_hint_still_says_how_to_add_one() {
    let repo = repo();
    let created = repo.run(&["vault", "add", "Secret", "--encrypted"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert!(
        out(&created).contains("no recipients yet"),
        "{}",
        out(&created)
    );
    assert!(out(&created).contains("key add"), "{}", out(&created));
    // And it now mentions the one-step way too.
    assert!(out(&created).contains("--recipient"), "{}", out(&created));
}

// --- Refusals: nothing is created --------------------------------------------

#[test]
fn a_recipient_on_a_plaintext_vault_is_refused() {
    // It would be dropped, and the user would believe the vault protected.
    let repo = repo();
    let me = identity(&repo, "me");
    let before = repo.manifest();

    let refused = repo.run(&["vault", "add", "Open", "--recipient", &me.public]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("--encrypted"), "{}", err(&refused));
    assert!(!repo.root.join("Open").exists());
    assert_eq!(repo.manifest(), before);
}

/// One mistyped character leaves a key with the right shape and no valid
/// checksum. It has to be refused up front, because accepting it produces a
/// vault that looks fine and fails on first write.
#[test]
fn a_mistyped_key_is_refused_and_nothing_is_created() {
    let repo = repo();
    let me = identity(&repo, "me");
    let before = repo.manifest();

    let mut typo = me.public.clone();
    let last = typo.pop().expect("a character");
    typo.push(if last == 'q' { 'p' } else { 'q' });

    let refused = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--recipient",
        &typo,
    ]);
    assert_eq!(code(&refused), 2, "{}", out(&refused));
    assert!(err(&refused).contains("mistyped"), "{}", err(&refused));
    assert!(
        err(&refused).contains("Nothing was created"),
        "{}",
        err(&refused)
    );
    assert!(
        !repo.root.join("Secret").exists(),
        "a directory was left behind"
    );
    assert_eq!(repo.manifest(), before, "fjord.json was changed");
}

#[test]
fn one_bad_key_among_good_ones_creates_nothing() {
    // The worst outcome is a vault with some of its keys: it looks usable,
    // and the missing ones fail later, on someone else's machine.
    let repo = repo();
    let me = identity(&repo, "me");
    let refused = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--recipient",
        &me.public,
        "--recipient",
        "age1nonsense",
    ]);
    assert_eq!(code(&refused), 2);
    assert!(!repo.root.join("Secret").exists());
}

/// Someone will paste an identity where a public key was wanted. It is
/// already in their shell history, but it must not also land in the output.
#[test]
fn a_secret_key_is_refused_and_never_echoed() {
    let repo = repo();
    let me = identity(&repo, "me");
    let identity_file =
        std::fs::read_to_string(me.config.join("identity.txt")).expect("read identity");
    let secret = identity_file
        .lines()
        .find(|line| line.starts_with("AGE-SECRET-KEY-"))
        .expect("a secret key")
        .to_string();

    let refused = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--recipient",
        &secret,
    ]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("secret key"), "{}", err(&refused));
    assert!(err(&refused).contains("exposed"), "{}", err(&refused));
    assert!(
        !err(&refused).contains(&secret) && !out(&refused).contains(&secret),
        "the secret key was printed back"
    );
    assert!(!repo.root.join("Secret").exists());
}

#[test]
fn ssh_and_passphrase_recipients_are_refused_with_their_reasons() {
    let repo = repo();
    let ssh = repo.run(&[
        "vault",
        "add",
        "A",
        "--encrypted",
        "--recipient",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 u@h",
    ]);
    assert_eq!(code(&ssh), 2);
    assert!(err(&ssh).contains("RUSTSEC-2023-0071"), "{}", err(&ssh));

    let pass = repo.run(&[
        "vault",
        "add",
        "B",
        "--encrypted",
        "--recipient",
        "passphrase",
    ]);
    assert_eq!(code(&pass), 2);
    assert!(err(&pass).contains("§6.2"), "{}", err(&pass));

    assert!(!repo.root.join("A").exists() && !repo.root.join("B").exists());
}

// --- --json -------------------------------------------------------------------

#[test]
fn json_describes_an_encrypted_vault_with_its_keys() {
    let repo = repo();
    let me = identity(&repo, "me");
    let created = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--id-naming",
        "--recipient",
        &me.public,
        "--json",
    ]);
    assert_eq!(code(&created), 0, "{}", err(&created));

    // stdout is the JSON and nothing else: no "created" line in front of it.
    let report = json(&created);
    assert_eq!(report["path"], "Secret");
    assert_eq!(report["name"], "Secret");
    assert_eq!(report["encrypted"], true);
    assert_eq!(report["fileNaming"], "id");
    assert_eq!(report["container"], "tar");
    assert_eq!(report["recipients"], serde_json::json!([me.public]));
    assert_eq!(report["id"].as_str().map(str::len), Some(26));

    let files: Vec<&str> = report["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(files.contains(&"Secret/fjord.vault.json"), "{files:?}");
    assert!(files.contains(&"Secret/recipients.txt"), "{files:?}");
    assert!(files.contains(&"Secret/.gitignore"), "{files:?}");
    for file in &files {
        assert!(
            repo.root.join(file).exists(),
            "{file} was reported but not written"
        );
    }

    // The id reported is the id written: a script can rely on it.
    assert!(repo.manifest().contains(report["id"].as_str().expect("id")));
}

#[test]
fn json_describes_a_plaintext_vault() {
    let repo = repo();
    let created = repo.run(&["vault", "add", "Archive", "--json"]);
    assert_eq!(code(&created), 0, "{}", err(&created));

    let report = json(&created);
    assert_eq!(report["encrypted"], false);
    assert_eq!(report["fileNaming"], "plain");
    assert_eq!(report["container"], "none");
    assert_eq!(report["recipients"], serde_json::json!([]));
    assert_eq!(
        report["files"],
        serde_json::json!(["Archive/fjord.vault.json"])
    );
}

#[test]
fn json_reports_an_encrypted_vault_with_no_keys_as_having_none() {
    let repo = repo();
    let created = repo.run(&["vault", "add", "Secret", "--encrypted", "--json"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert_eq!(json(&created)["recipients"], serde_json::json!([]));
    // The human hint is for humans: a script reading stdout must not get it.
    assert!(
        !out(&created).contains("no recipients yet"),
        "{}",
        out(&created)
    );
}

#[test]
fn a_refusal_under_json_is_an_error_on_stderr_and_nothing_on_stdout() {
    let repo = repo();
    let refused = repo.run(&["vault", "add", "Bad", "--id-naming", "--json"]);
    assert_eq!(code(&refused), 2);
    assert_eq!(out(&refused), "", "stdout should be empty on a refusal");
    assert!(err(&refused).contains("§7.2"), "{}", err(&refused));
}

#[test]
fn quiet_is_still_quiet() {
    let repo = repo();
    let created = repo.run(&["vault", "add", "Archive", "--quiet"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert_eq!(out(&created), "");
}

// --- The checksum bug this turned up ---------------------------------------------

/// `key add` used to accept any key with the right length and alphabet. A
/// mistyped character passed, the vault became unwritable ("invalid Bech32
/// encoding" on the next `new`), and `verify` reported it clean.
#[test]
fn key_add_refuses_a_key_that_does_not_check_out() {
    let repo = repo();
    let before = std::fs::read_to_string(repo.root.join("Private/recipients.txt")).expect("read");

    let bad = format!("age1{}", "q".repeat(58));
    let refused = repo.run(&["key", "add", &bad, "--vault", "Private"]);
    assert_eq!(code(&refused), 2, "{}", out(&refused));
    assert!(err(&refused).contains("mistyped"), "{}", err(&refused));
    assert_eq!(
        std::fs::read_to_string(repo.root.join("Private/recipients.txt")).expect("read"),
        before,
        "the bad key was written anyway"
    );
}

#[test]
fn key_add_never_echoes_a_secret_key() {
    let repo = repo();
    let me = identity(&repo, "me");
    let text = std::fs::read_to_string(me.config.join("identity.txt")).expect("read");
    let secret = text
        .lines()
        .find(|line| line.starts_with("AGE-SECRET-KEY-"))
        .expect("a secret key")
        .to_string();

    let refused = repo.run(&["key", "add", &secret, "--vault", "Private"]);
    assert_eq!(code(&refused), 2);
    assert!(!err(&refused).contains(&secret) && !out(&refused).contains(&secret));
    assert!(err(&refused).contains("secret key"), "{}", err(&refused));
}

#[test]
fn key_add_refuses_ssh_because_the_vault_could_not_then_be_written() {
    // It used to accept one, leaving a vault this build then failed to
    // encrypt to.
    let repo = repo();
    let refused = repo.run(&[
        "key",
        "add",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 u@h",
        "--vault",
        "Private",
    ]);
    assert_eq!(code(&refused), 2);
    assert!(
        err(&refused).contains("RUSTSEC-2023-0071"),
        "{}",
        err(&refused)
    );
}

// --- --commit -----------------------------------------------------------------

fn git(repo: &Repo, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(&repo.root)
        .args(arguments)
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn commit_count(repo: &Repo) -> usize {
    git(repo, &["rev-list", "--count", "HEAD"])
        .parse()
        .expect("a number")
}

/// What a commit touched, sorted.
fn files_in_head(repo: &Repo) -> Vec<String> {
    let mut files: Vec<String> = git(repo, &["show", "--name-only", "--format=", "HEAD"])
        .lines()
        .map(String::from)
        .collect();
    files.sort();
    files
}

#[test]
fn commit_records_exactly_the_vault_and_its_manifest_entry() {
    let repo = repo();
    let me = identity(&repo, "me");
    let before = commit_count(&repo);

    let created = repo.run(&[
        "vault",
        "add",
        "Secret",
        "--encrypted",
        "--recipient",
        &me.public,
        "--commit",
    ]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert!(out(&created).contains("committed"), "{}", out(&created));
    assert!(
        out(&created).contains("Add vault Secret"),
        "{}",
        out(&created)
    );

    assert_eq!(
        commit_count(&repo),
        before + 1,
        "expected exactly one new commit"
    );
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s"]),
        "Add vault Secret"
    );

    // Every file of the vault, including the three the vault's own guard
    // `.gitignore` has to let through — and fjord.json, which lists it.
    assert_eq!(
        files_in_head(&repo),
        vec![
            "Secret/.gitignore".to_string(),
            "Secret/fjord.vault.json".to_string(),
            "Secret/recipients.txt".to_string(),
            "fjord.json".to_string(),
        ]
    );

    // Nothing is left over: the working tree is clean.
    assert_eq!(git(&repo, &["status", "--porcelain"]), "");
}

#[test]
fn a_plaintext_vault_can_be_committed_too() {
    let repo = repo();
    let created = repo.run(&["vault", "add", "Archive", "--commit"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert_eq!(
        files_in_head(&repo),
        vec![
            "Archive/fjord.vault.json".to_string(),
            "fjord.json".to_string()
        ]
    );
    assert_eq!(git(&repo, &["status", "--porcelain"]), "");
}

/// `git commit` with no pathspec takes the whole index. Someone who had
/// already staged something else would find it inside a commit that says it
/// adds a vault. The command must take its own files and nothing more.
#[test]
fn work_you_had_already_staged_is_not_swept_into_the_commit() {
    let repo = repo();

    // Three kinds of unrelated work: staged, changed-but-unstaged, untracked.
    std::fs::write(repo.root.join("Public/staged.md"), "staged\n").expect("write");
    git(&repo, &["add", "Public/staged.md"]);
    std::fs::write(repo.root.join("Public/welcome.md"), "edited, not staged\n").expect("write");
    std::fs::write(repo.root.join("Public/untracked.md"), "untracked\n").expect("write");

    let created = repo.run(&["vault", "add", "Archive", "--commit"]);
    assert_eq!(code(&created), 0, "{}", err(&created));

    // The commit holds the vault and nothing from `Public/`.
    let committed = files_in_head(&repo);
    assert!(
        committed.iter().all(|file| !file.starts_with("Public/")),
        "unrelated work was committed: {committed:?}"
    );

    // And all three are exactly as they were.
    assert_eq!(
        git(&repo, &["diff", "--cached", "--name-only"]),
        "Public/staged.md"
    );
    let status = git(&repo, &["status", "--porcelain"]);
    assert!(status.contains("A  Public/staged.md"), "{status}");
    assert!(status.contains(" M Public/welcome.md"), "{status}");
    assert!(status.contains("?? Public/untracked.md"), "{status}");
}

#[test]
fn without_commit_nothing_is_committed() {
    // The default is unchanged: like `new`, `encrypt` and `key add`, this
    // leaves the decision about a commit to you.
    let repo = repo();
    let before = commit_count(&repo);

    let created = repo.run(&["vault", "add", "Archive"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert!(!out(&created).contains("committed"), "{}", out(&created));
    assert_eq!(commit_count(&repo), before);

    let status = git(&repo, &["status", "--porcelain"]);
    assert!(status.contains("Archive/"), "{status}");
}

#[test]
fn commit_outside_a_git_repository_is_refused_before_anything_is_created() {
    // A vault made and then not committed, when a commit was asked for, is a
    // half-done job — so the request is refused up front.
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &root.to_string_lossy(), "--no-git"])
        .env("NO_COLOR", "1")
        .output()
        .expect("init");
    assert_eq!(init.status.code(), Some(0), "{}", err(&init));
    let manifest = std::fs::read_to_string(root.join("fjord.json")).expect("read");

    let refused = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .arg("-C")
        .arg(&root)
        .args(["vault", "add", "Archive", "--commit"])
        .env("NO_COLOR", "1")
        .output()
        .expect("run");
    assert_eq!(code(&refused), 2);
    assert!(
        err(&refused).contains("git repository"),
        "{}",
        err(&refused)
    );
    assert!(!root.join("Archive").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("fjord.json")).expect("read"),
        manifest
    );
}

/// The vault exists by the time the commit is attempted, and the obvious
/// next move is to run the same command again and be told it already
/// exists. So the error has to say what happened and what to do.
#[test]
fn a_commit_that_fails_says_the_vault_was_created() {
    let repo = repo();
    let home = repo.temp.path().join("empty-home");
    std::fs::create_dir_all(&home).expect("create");

    // No identity anywhere, and git forbidden from guessing one from the
    // hostname — which it otherwise does on some machines, so without this
    // the test would depend on where it runs.
    let failed = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .arg("-C")
        .arg(&repo.root)
        .args(["vault", "add", "Archive", "--commit"])
        .env("NO_COLOR", "1")
        .env("HOME", &home)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "user.useConfigOnly")
        .env("GIT_CONFIG_VALUE_0", "true")
        .env_remove("GIT_AUTHOR_NAME")
        .env_remove("GIT_AUTHOR_EMAIL")
        .env_remove("GIT_COMMITTER_NAME")
        .env_remove("GIT_COMMITTER_EMAIL")
        .output()
        .expect("run");

    assert_ne!(code(&failed), 0, "{}", out(&failed));
    let message = err(&failed);
    assert!(
        message.contains("was created, but could not be committed"),
        "{message}"
    );
    assert!(message.contains("git add Archive fjord.json"), "{message}");
    // The vault is really there, so the message is true.
    assert!(repo.root.join("Archive/fjord.vault.json").is_file());
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn json_says_whether_a_commit_was_made() {
    let repo = repo();
    let plain = repo.run(&["vault", "add", "One", "--json"]);
    assert_eq!(json(&plain)["committed"], false);

    let committed = repo.run(&["vault", "add", "Two", "--commit", "--json"]);
    assert_eq!(code(&committed), 0, "{}", err(&committed));
    let report = json(&committed);
    assert_eq!(report["committed"], true);
    // Still only JSON on stdout, with no "committed" line in front of it.
    assert!(
        out(&committed).trim_start().starts_with('{'),
        "{}",
        out(&committed)
    );
}

#[test]
fn quiet_commit_prints_nothing_but_still_commits() {
    let repo = repo();
    let before = commit_count(&repo);
    let created = repo.run(&["vault", "add", "Archive", "--commit", "--quiet"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert_eq!(out(&created), "");
    assert_eq!(commit_count(&repo), before + 1);
}

//! `fjord sync`. Spec §9.1.
//!
//! M6's acceptance criteria are two sentences, and the first two tests are
//! exactly them: divergent commits touching one encrypted Doc produce a
//! correctly merged result, and an unresolvable merge leaves both versions
//! on disk and exits 1.
//!
//! Every test builds a real remote and two real clones, because the thing
//! under test is a three-way merge of ciphertext and there is no honest way
//! to fake one.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A bare remote, two clones of it, and one identity both can decrypt
/// with — the shape of a person syncing between two machines.
struct World {
    temp: tempfile::TempDir,
    config: PathBuf,
    first: PathBuf,
    second: PathBuf,
}

fn fjord_in(root: &Path, config: &Path, arguments: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
    command
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", config)
        .env("TMPDIR", root.parent().unwrap_or(root))
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .env_remove("FJORD_IDENTITY")
        .env_remove("EDITOR")
        .env_remove("VISUAL");
    command.output().expect("run fjord")
}

fn git(root: &Path, arguments: &[&str]) -> Output {
    Command::new("git")
        .current_dir(root)
        .args(arguments)
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("run git")
}

fn git_ok(root: &Path, arguments: &[&str]) {
    let output = git(root, arguments);
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

impl World {
    fn first(&self, arguments: &[&str]) -> Output {
        fjord_in(&self.first, &self.config, arguments)
    }

    fn second(&self, arguments: &[&str]) -> Output {
        fjord_in(&self.second, &self.config, arguments)
    }

    /// Replace a document's plaintext, through fjord, in one clone.
    fn write_document(&self, root: &Path, logical: &str, contents: &str) {
        let payload = root.join(format!("{logical}.age"));
        if payload.exists() {
            std::fs::remove_file(&payload).expect("remove payload");
        }
        let plain = root.join(logical);
        std::fs::write(&plain, contents).expect("write plaintext");
        let encrypted = fjord_in(root, &self.config, &["encrypt", logical]);
        assert_eq!(
            encrypted.status.code(),
            Some(0),
            "encrypt: {}",
            String::from_utf8_lossy(&encrypted.stderr)
        );
    }

    fn read_document(&self, root: &Path, logical: &str) -> String {
        let output = fjord_in(root, &self.config, &["decrypt", &format!("{logical}.age")]);
        assert_eq!(
            output.status.code(),
            Some(0),
            "decrypt {logical}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }
}

fn world() -> World {
    let temp = tempfile::tempdir().expect("temp");
    let config = temp.path().join("config");
    let remote = temp.path().join("remote.git");
    let first = temp.path().join("first");
    let second = temp.path().join("second");

    // One identity, shared between both clones: §6.2's model is one key per
    // device, and a test with two keys would only prove `age -R` twice.
    let generated = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &config)
        .current_dir(temp.path())
        .output()
        .expect("key new");
    assert_eq!(generated.status.code(), Some(0));
    let report: serde_json::Value = serde_json::from_slice(&generated.stdout).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();

    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &first.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(init.status.code(), Some(0));

    let world = World {
        temp,
        config,
        first,
        second,
    };

    let added = world.first(&["key", "add", &recipient, "--vault", "Private"]);
    assert_eq!(added.status.code(), Some(0));

    git_ok(
        remote.parent().expect("parent"),
        &["init", "--bare", "-b", "main", &remote.to_string_lossy()],
    );
    git_ok(
        &world.first,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    git_ok(&world.first, &["add", "-A"]);
    git_ok(&world.first, &["commit", "-m", "Register a key"]);
    git_ok(&world.first, &["push", "-u", "origin", "main"]);

    git_ok(
        world.temp.path(),
        &[
            "clone",
            "--quiet",
            &remote.to_string_lossy(),
            &world.second.to_string_lossy(),
        ],
    );

    world
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

// --- The acceptance criteria ---------------------------------------------

/// "A test fabricates divergent commits touching one encrypted Doc and sync
/// produces a correctly merged result."
#[test]
fn divergent_edits_to_one_encrypted_document_are_merged() {
    let world = world();

    // A shared starting point: a document with room to diverge.
    world.write_document(
        &world.first,
        "Private/notes.md",
        "# Notes\n\nfirst line\nsecond line\nthird line\n",
    );
    assert_eq!(code(&world.first(&["sync"])), 0);
    assert_eq!(code(&world.second(&["sync"])), 0);

    // Each side edits a different end of the same document, and commits
    // without seeing the other.
    world.write_document(
        &world.first,
        "Private/notes.md",
        "# Notes\n\nfirst line, edited here\nsecond line\nthird line\n",
    );
    assert_eq!(code(&world.first(&["sync"])), 0);

    world.write_document(
        &world.second,
        "Private/notes.md",
        "# Notes\n\nfirst line\nsecond line\nthird line, edited there\n",
    );

    // Git cannot merge these: they are two unrelated ciphertexts. Fjord
    // decrypts both sides and the base, merges the plaintext, re-encrypts.
    let synced = world.second(&["sync"]);
    assert_eq!(
        code(&synced),
        0,
        "sync failed: {}{}",
        out(&synced),
        err(&synced)
    );
    assert!(
        out(&synced).contains("merged"),
        "expected a merge to be reported: {}",
        out(&synced)
    );

    // Both edits survived, in one document.
    let merged = world.read_document(&world.second, "Private/notes.md");
    assert_eq!(
        merged, "# Notes\n\nfirst line, edited here\nsecond line\nthird line, edited there\n",
        "the merge lost an edit"
    );
    assert!(
        !merged.contains("<<<<<<<"),
        "conflict markers survived: {merged}"
    );

    // The repository is left conforming, with no plaintext anywhere.
    let verified = world.second(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", out(&verified));
    assert!(!world.second.join("Private/notes.md").exists());

    // And the first clone receives the merge.
    assert_eq!(code(&world.first(&["sync"])), 0);
    assert_eq!(
        world.read_document(&world.first, "Private/notes.md"),
        merged
    );
}

/// "An unresolvable merge leaves both versions on disk and exits 1."
#[test]
fn an_unresolvable_merge_keeps_both_versions_and_exits_one() {
    let world = world();

    world.write_document(
        &world.first,
        "Private/notes.md",
        "# Notes\n\nthe contested line\n",
    );
    assert_eq!(code(&world.first(&["sync"])), 0);
    assert_eq!(code(&world.second(&["sync"])), 0);

    // Both sides rewrite the same line, which no three-way merge can
    // reconcile.
    world.write_document(
        &world.first,
        "Private/notes.md",
        "# Notes\n\nthe line as the first machine wants it\n",
    );
    assert_eq!(code(&world.first(&["sync"])), 0);

    world.write_document(
        &world.second,
        "Private/notes.md",
        "# Notes\n\nthe line as the second machine wants it\n",
    );

    let synced = world.second(&["sync"]);
    assert_eq!(
        code(&synced),
        1,
        "an unresolved conflict must exit 1: {}{}",
        out(&synced),
        err(&synced)
    );
    assert!(out(&synced).contains("conflict"), "{}", out(&synced));

    // Invariant 5: neither side was discarded. Ours is untouched...
    assert_eq!(
        world.read_document(&world.second, "Private/notes.md"),
        "# Notes\n\nthe line as the second machine wants it\n",
        "our version was not left as it was"
    );

    // ...and theirs is alongside it.
    let listed = world.second(&["ls", "Private", "-R"]);
    let alongside = out(&listed)
        .lines()
        .map(|line| line.split_whitespace().next().unwrap_or("").to_string())
        .find(|path| path.contains("conflict-"))
        .expect("theirs should be kept alongside");

    let theirs = world.read_document(
        &world.second,
        alongside
            .strip_suffix(".md")
            .map(|stem| format!("{stem}.md"))
            .as_deref()
            .unwrap_or(&alongside),
    );
    assert!(
        theirs.contains("the line as the first machine wants it"),
        "their version was lost: {theirs}"
    );

    // Both are conforming Docs, with distinct ids — §9.1's remedy, and the
    // fresh id is what stops this becoming an E401.
    let verified = world.second(&["verify", "--json"]);
    let report: serde_json::Value = serde_json::from_str(&out(&verified)).expect("json");
    assert_eq!(
        report["counts"]["errors"],
        serde_json::Value::from(0),
        "keeping both versions must not break conformance: {}",
        out(&verified)
    );

    // Nothing was pushed: the other machine must not inherit this.
    assert!(
        out(&synced).contains("nothing was pushed"),
        "{}",
        out(&synced)
    );
    let ahead = git(&world.second, &["rev-list", "--count", "origin/main..HEAD"]);
    assert_ne!(
        String::from_utf8_lossy(&ahead.stdout).trim(),
        "0",
        "the conflict was pushed anyway"
    );
}

// --- The ordinary path ---------------------------------------------------

#[test]
fn sync_commits_local_changes_and_pushes_them() {
    let world = world();
    world.write_document(&world.first, "Private/notes.md", "# Notes\n\nlocal\n");

    let synced = world.first(&["sync", "--message", "Add notes"]);
    assert_eq!(code(&synced), 0, "{}{}", out(&synced), err(&synced));
    assert!(out(&synced).contains("pushed"), "{}", out(&synced));

    let log = git(&world.first, &["log", "-1", "--format=%s"]);
    assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "Add notes");

    // The other clone receives it.
    assert_eq!(code(&world.second(&["sync"])), 0);
    assert_eq!(
        world.read_document(&world.second, "Private/notes.md"),
        "# Notes\n\nlocal\n"
    );
}

#[test]
fn a_fast_forward_needs_no_merge() {
    let world = world();
    world.write_document(&world.first, "Private/notes.md", "# Notes\n\none\n");
    assert_eq!(code(&world.first(&["sync"])), 0);

    let synced = world.second(&["sync"]);
    assert_eq!(code(&synced), 0, "{}{}", out(&synced), err(&synced));
    assert!(out(&synced).contains("pulled"), "{}", out(&synced));
    assert!(!out(&synced).contains("conflict"), "{}", out(&synced));
}

#[test]
fn nothing_to_do_says_so() {
    let world = world();
    let synced = world.first(&["sync"]);
    assert_eq!(code(&synced), 0, "{}{}", out(&synced), err(&synced));
    assert!(out(&synced).contains("up to date"), "{}", out(&synced));
}

#[test]
fn no_push_pulls_without_pushing() {
    let world = world();
    world.write_document(&world.first, "Private/notes.md", "# Notes\n\nlocal\n");

    let synced = world.first(&["sync", "--no-push"]);
    assert_eq!(code(&synced), 0, "{}{}", out(&synced), err(&synced));
    assert!(!out(&synced).contains("pushed"), "{}", out(&synced));

    let ahead = git(&world.first, &["rev-list", "--count", "origin/main..HEAD"]);
    assert_eq!(String::from_utf8_lossy(&ahead.stdout).trim(), "1");
}

#[test]
fn a_plaintext_vault_takes_the_same_path() {
    // §9.1: "Clients SHOULD use the same path for plaintext vaults, so one
    // implementation serves both."
    let world = world();
    std::fs::write(
        world.first.join("Public/shared.md"),
        "# Shared\n\nfirst line\nsecond line\nthird line\n",
    )
    .expect("write");
    assert_eq!(code(&world.first(&["sync"])), 0);
    assert_eq!(code(&world.second(&["sync"])), 0);

    std::fs::write(
        world.first.join("Public/shared.md"),
        "# Shared\n\nfirst line, edited here\nsecond line\nthird line\n",
    )
    .expect("write");
    assert_eq!(code(&world.first(&["sync"])), 0);

    std::fs::write(
        world.second.join("Public/shared.md"),
        "# Shared\n\nfirst line\nsecond line\nthird line, edited there\n",
    )
    .expect("write");

    let synced = world.second(&["sync"]);
    assert_eq!(code(&synced), 0, "{}{}", out(&synced), err(&synced));
    assert_eq!(
        std::fs::read_to_string(world.second.join("Public/shared.md")).expect("read"),
        "# Shared\n\nfirst line, edited here\nsecond line\nthird line, edited there\n"
    );
}

#[test]
fn a_binary_document_is_never_text_merged() {
    // A PDF has no lines. Merging it as text would corrupt it, so both
    // versions are kept instead.
    let world = world();
    let first_bytes: Vec<u8> = (0..=255u8).cycle().take(2048).collect();
    let second_bytes: Vec<u8> = (0..=255u8).rev().cycle().take(2048).collect();

    std::fs::write(world.first.join("Private/scan.bin"), &first_bytes).expect("write");
    assert_eq!(code(&world.first(&["encrypt", "Private/scan.bin"])), 0);
    assert_eq!(code(&world.first(&["sync"])), 0);
    assert_eq!(code(&world.second(&["sync"])), 0);

    std::fs::write(
        world.first.join("Private/scan.bin"),
        b"changed here" as &[u8],
    )
    .expect("write");
    std::fs::remove_file(world.first.join("Private/scan.bin.age")).expect("remove");
    assert_eq!(code(&world.first(&["encrypt", "Private/scan.bin"])), 0);
    assert_eq!(code(&world.first(&["sync"])), 0);

    std::fs::write(world.second.join("Private/scan.bin"), &second_bytes).expect("write");
    std::fs::remove_file(world.second.join("Private/scan.bin.age")).expect("remove");
    assert_eq!(code(&world.second(&["encrypt", "Private/scan.bin"])), 0);

    let synced = world.second(&["sync"]);
    assert_eq!(code(&synced), 1, "{}{}", out(&synced), err(&synced));
    assert!(
        out(&synced).contains("no lines to merge"),
        "{}",
        out(&synced)
    );

    // Our bytes are intact, exactly.
    let ours = world.second(&["decrypt", "Private/scan.bin.age"]);
    assert_eq!(ours.stdout, second_bytes, "our binary document was altered");
}

#[test]
fn without_an_identity_both_versions_are_kept() {
    let world = world();
    world.write_document(&world.first, "Private/notes.md", "# Notes\n\nline\n");
    assert_eq!(code(&world.first(&["sync"])), 0);
    assert_eq!(code(&world.second(&["sync"])), 0);

    world.write_document(&world.first, "Private/notes.md", "# Notes\n\nours\n");
    assert_eq!(code(&world.first(&["sync"])), 0);
    world.write_document(&world.second, "Private/notes.md", "# Notes\n\ntheirs\n");

    // A collaborator who cannot read the vault still must not lose either
    // version.
    let blind = world.temp.path().join("no-identity");
    std::fs::create_dir_all(&blind).expect("create");
    let synced = fjord_in(&world.second, &blind, &["sync"]);
    assert_eq!(code(&synced), 1, "{}{}", out(&synced), err(&synced));
    assert!(out(&synced).contains("no identity"), "{}", out(&synced));

    // Two payloads on disk, neither of them touched.
    let payloads: Vec<String> = std::fs::read_dir(world.second.join("Private"))
        .expect("read")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".age"))
        .collect();
    assert_eq!(
        payloads.len(),
        2,
        "both versions must survive: {payloads:?}"
    );
    assert_eq!(
        world.read_document(&world.second, "Private/notes.md"),
        "# Notes\n\ntheirs\n"
    );
}

/// `git remote add` sets no upstream, so the first `fjord sync` after it
/// used to report "no remote tracked" — true, unhelpful, and
/// indistinguishable from having no remote at all.
#[test]
fn the_first_sync_after_adding_a_remote_establishes_tracking() {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let config = temp.path().join("config");
    let remote = temp.path().join("remote.git");

    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(init.status.code(), Some(0));

    git_ok(
        temp.path(),
        &["init", "--bare", "-b", "main", &remote.to_string_lossy()],
    );
    git_ok(
        &root,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    // Deliberately no `git push -u`: that is the step being removed.

    let synced = fjord_in(&root, &config, &["sync"]);
    assert_eq!(code(&synced), 0, "{}{}", out(&synced), err(&synced));
    assert!(out(&synced).contains("pushed"), "{}", out(&synced));
    assert!(out(&synced).contains("now tracked"), "{}", out(&synced));

    // The upstream is set, so the next sync is unambiguous.
    let upstream = git(&root, &["rev-parse", "--abbrev-ref", "@{u}"]);
    assert_eq!(
        String::from_utf8_lossy(&upstream.stdout).trim(),
        "origin/main"
    );

    let again = fjord_in(&root, &config, &["sync"]);
    assert_eq!(code(&again), 0, "{}{}", out(&again), err(&again));
    assert!(out(&again).contains("up to date"), "{}", out(&again));
}

#[test]
fn several_remotes_without_an_upstream_is_a_usage_error() {
    // Which one would it have picked?
    let world = world();
    git_ok(
        &world.second,
        &["remote", "add", "elsewhere", &world.first.to_string_lossy()],
    );
    git_ok(&world.second, &["branch", "--unset-upstream"]);

    let synced = world.second(&["sync"]);
    assert_eq!(code(&synced), 2);
    assert!(err(&synced).contains("elsewhere"), "{}", err(&synced));
    assert!(err(&synced).contains("git push -u"), "{}", err(&synced));
}

#[test]
fn a_repository_with_no_remote_is_not_an_error() {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let config = temp.path().join("config");
    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(init.status.code(), Some(0));

    std::fs::write(root.join("Public/notes.md"), "# Notes\n").expect("write");
    let synced = fjord_in(&root, &config, &["sync"]);
    assert_eq!(code(&synced), 0, "{}{}", out(&synced), err(&synced));
    assert!(
        out(&synced).contains("no remote configured"),
        "{}",
        out(&synced)
    );

    // The local work was still committed, which is the useful half.
    let log = git(&root, &["log", "-1", "--format=%s"]);
    assert_eq!(
        String::from_utf8_lossy(&log.stdout).trim(),
        "Sync local changes"
    );
}

#[test]
fn a_newer_repository_is_never_synced() {
    // Invariant 4: writing to it is refused, and sync writes.
    let world = world();
    let manifest = world.first.join("fjord.json");
    let contents = std::fs::read_to_string(&manifest).expect("read");
    std::fs::write(&manifest, contents.replace("\"fjord\": 1", "\"fjord\": 2")).expect("write");

    let synced = world.first(&["sync"]);
    assert_eq!(code(&synced), 2);
    assert!(err(&synced).contains("version 2"), "{}", err(&synced));
}

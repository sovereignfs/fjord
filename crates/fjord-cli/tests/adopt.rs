// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord init --adopt`: making a Fjord repository of a directory that already has files (RFC 0002, P16).
//!
//! What is held here is what makes adoption safe to run on somebody's directory: nothing that is there is
//! changed (byte for byte), only Fjord's own files are committed, work that is not committed stays that
//! way, and encrypting what is already there goes through a checkout that nothing can commit past.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Directory {
    _temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}

impl Directory {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temporary directory");
        let root = temp.path().join("mine");
        std::fs::create_dir(&root).expect("mkdir");
        let config = temp.path().join("config");
        std::fs::create_dir(&config).expect("mkdir");
        Directory {
            _temp: temp,
            root: std::fs::canonicalize(root).expect("canonical"),
            config,
        }
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.root.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, text).expect("write");
    }

    fn git(&self, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(&self.root)
            .env("GIT_AUTHOR_NAME", "Someone")
            .env("GIT_AUTHOR_EMAIL", "someone@example.invalid")
            .env("GIT_COMMITTER_NAME", "Someone")
            .env("GIT_COMMITTER_EMAIL", "someone@example.invalid")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            text(&output)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    fn with_history(&self) {
        self.git(&["init", "-q", "-b", "main"]);
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", "before Fjord"]);
    }

    fn fjord(&self, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_fjord"))
            .args(["--no-input", "-C"])
            .arg(&self.root)
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .output()
            .expect("run fjord")
    }

    /// `fjord init --adopt` here. (`-C` is the repository, which is this directory, before `fjord.json`
    /// exists: `init` takes the directory as its own argument.)
    fn adopt(&self, arguments: &[&str]) -> Output {
        let mut all = vec!["--no-input", "init"];
        let root = self.root.to_string_lossy().to_string();
        all.push(&root);
        all.push("--adopt");
        all.extend_from_slice(arguments);
        Command::new(env!("CARGO_BIN_EXE_fjord"))
            .args(&all)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .output()
            .expect("run fjord")
    }

    /// Every file outside `.git` and `.fjord`, with its bytes.
    fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).expect("read_dir") {
                let path = entry.expect("entry").path();
                let name = path
                    .file_name()
                    .expect("name")
                    .to_string_lossy()
                    .to_string();
                if name == ".git" || name == ".fjord" {
                    continue;
                }
                if path.is_dir() {
                    walk(base, &path, out);
                } else {
                    let relative = path.strip_prefix(base).expect("inside");
                    out.insert(
                        relative.to_string_lossy().replace('\\', "/"),
                        std::fs::read(&path).expect("read"),
                    );
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.root, &self.root, &mut out);
        out
    }
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("an exit code")
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|err| panic!("not JSON ({err}): {}", text(output)))
}

/// What changed between two snapshots: the files that were added, and those that differ.
fn difference(
    before: &BTreeMap<String, Vec<u8>>,
    after: &BTreeMap<String, Vec<u8>>,
) -> (Vec<String>, Vec<String>) {
    let added = after
        .keys()
        .filter(|path| !before.contains_key(*path))
        .cloned()
        .collect();
    let changed = before
        .iter()
        .filter(|(path, bytes)| after.get(*path).is_some_and(|now| now != *bytes))
        .map(|(path, _)| path.clone())
        .collect();
    let removed: Vec<String> = before
        .keys()
        .filter(|path| !after.contains_key(*path))
        .cloned()
        .collect();
    assert!(removed.is_empty(), "adopting removed {removed:?}");
    (added, changed)
}

#[test]
fn adopting_a_drive_leaves_every_file_as_it_was_and_commits_only_its_own() {
    let dir = Directory::new();
    dir.write("README.md", "readme\n");
    dir.write("notes/a.md", "# A\n");
    dir.write("notes/sub/b.txt", "b\n");
    dir.write(".gitignore", "target/\n");
    dir.write(".gitattributes", "*.png binary\n");
    dir.with_history();
    // Work that is not committed, in the two ways there are.
    dir.write("README.md", "readme\nedited, not staged\n");
    dir.write("scratch.txt", "untracked\n");
    let before = dir.snapshot();

    let adopted = dir.adopt(&["--vault", "notes"]);
    assert_eq!(code(&adopted), 0, "{}", text(&adopted));

    let after = dir.snapshot();
    let (added, changed) = difference(&before, &after);
    assert_eq!(added, ["fjord.json", "notes/fjord.vault.json"]);
    // Only `.gitattributes` grew (spec §9's guard), and by lines at its end; `.gitignore` is untouched
    // because nothing is encrypted.
    assert_eq!(changed, [".gitattributes"]);
    assert!(after[".gitattributes"].starts_with(&before[".gitattributes"]));

    // One new commit, with only Fjord's files in it.
    let changed_in_commit = dir.git(&["show", "--name-only", "--format=", "HEAD"]);
    let mut files: Vec<&str> = changed_in_commit.lines().collect();
    files.sort_unstable();
    assert_eq!(
        files,
        [".gitattributes", "fjord.json", "notes/fjord.vault.json"]
    );
    // The work that was not committed still is not.
    let status = dir.git(&["status", "--short"]);
    assert!(status.contains(" M README.md"), "{status}");
    assert!(status.contains("?? scratch.txt"), "{status}");

    let verified = dir.fjord(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", text(&verified));
}

#[test]
fn a_directory_that_is_not_a_repository_gets_one_with_only_fjords_files_committed() {
    let dir = Directory::new();
    dir.write("notes/a.md", "# A\n");
    let before = dir.snapshot();

    let adopted = dir.adopt(&["--vault", "notes"]);
    assert_eq!(code(&adopted), 0, "{}", text(&adopted));

    let (added, changed) = difference(&before, &dir.snapshot());
    assert_eq!(
        added,
        [".gitattributes", "fjord.json", "notes/fjord.vault.json"]
    );
    assert!(changed.is_empty());
    let committed = dir.git(&["show", "--name-only", "--format=", "HEAD"]);
    assert!(!committed.contains("notes/a.md"), "{committed}");
    assert!(dir.git(&["status", "--short"]).contains("?? notes/"));
}

#[test]
fn a_vault_can_be_any_directory_at_any_depth_and_a_drive_can_have_several() {
    let dir = Directory::new();
    dir.write("a/one.md", "1\n");
    dir.write("deep/er/two.md", "2\n");
    let adopted = dir.adopt(&["--vault", "a", "--vault", "deep/er", "--no-git"]);
    assert_eq!(code(&adopted), 0, "{}", text(&adopted));
    let verified = dir.fjord(&["verify", "--json"]);
    assert_eq!(code(&verified), 0, "{}", text(&verified));
    let vaults: Vec<String> = json(&verified)["vaults"]
        .as_array()
        .expect("vaults")
        .iter()
        .map(|v| v["path"].as_str().expect("path").to_string())
        .collect();
    assert_eq!(vaults, ["a", "deep/er"]);
}

#[test]
fn an_astro_site_is_adopted_where_its_engine_keeps_its_content() {
    let dir = Directory::new();
    dir.write("astro.config.mjs", "export default {};\n");
    dir.write("package.json", "{}\n");
    dir.write("src/content/posts/hello.md", "---\ntitle: Hello\n---\nHi\n");
    dir.with_history();
    let before = dir.snapshot();

    let adopted = dir.adopt(&["--kind", "ssg"]);
    assert_eq!(code(&adopted), 0, "{}", text(&adopted));

    let (added, _) = difference(&before, &dir.snapshot());
    assert_eq!(
        added,
        [
            ".gitattributes",
            "fjord.json",
            "src/content/fjord.vault.json"
        ],
        "the engine's files and the posts are as they were"
    );
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.root.join("fjord.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["kind"], "ssg");
    assert_eq!(manifest["ssg"]["engine"], "astro");
    assert_eq!(manifest["vaults"][0]["path"], "src/content");
    let verified = dir.fjord(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", text(&verified));
}

#[test]
fn a_jekyll_site_is_found_by_its_config() {
    let dir = Directory::new();
    dir.write("_config.yml", "title: x\n");
    dir.write("_posts/2026-01-01-a.md", "---\nlayout: post\n---\nA\n");
    let adopted = dir.adopt(&["--kind", "ssg", "--no-git"]);
    assert_eq!(code(&adopted), 0, "{}", text(&adopted));
    let manifest = std::fs::read_to_string(dir.root.join("fjord.json")).unwrap();
    assert!(
        manifest.contains("\"jekyll\"") && manifest.contains("\"_posts\""),
        "{manifest}"
    );
}

#[test]
fn a_site_whose_engine_cannot_be_told_is_asked_for_not_guessed() {
    let dir = Directory::new();
    dir.write("content/a.md", "A\n");
    let refused = dir.adopt(&["--kind", "ssg", "--no-git"]);
    assert_eq!(code(&refused), 2, "{}", text(&refused));
    assert!(text(&refused).contains("--engine"), "{}", text(&refused));
    assert!(!dir.root.join("fjord.json").exists());

    let named = dir.adopt(&[
        "--kind", "ssg", "--engine", "astro", "--vault", "content", "--no-git",
    ]);
    assert_eq!(code(&named), 0, "{}", text(&named));
}

#[test]
fn a_new_journal_is_encrypted_but_a_directory_of_notes_must_choose() {
    // Nothing there yet: encrypted by default, as `init --kind journal` is.
    let empty = Directory::new();
    let adopted = empty.adopt(&["--kind", "journal", "--no-git"]);
    assert_eq!(code(&adopted), 0, "{}", text(&adopted));
    let manifest = std::fs::read_to_string(empty.root.join("journal/fjord.vault.json")).unwrap();
    assert!(manifest.contains("\"fileNaming\": \"id\""), "{manifest}");
    assert!(empty.root.join("journal/recipients.txt").is_file());

    // Notes already there: whether to encrypt them is not decided silently either way.
    let notes = Directory::new();
    notes.write("journal/2026-11-02.md", "Dear diary\n");
    let before = notes.snapshot();
    let refused = notes.adopt(&["--kind", "journal", "--no-git"]);
    assert_eq!(code(&refused), 2, "{}", text(&refused));
    assert!(
        text(&refused).contains("--no-encrypt"),
        "{}",
        text(&refused)
    );
    assert!(
        text(&refused).contains("--encrypt-existing"),
        "{}",
        text(&refused)
    );
    assert_eq!(notes.snapshot(), before, "a refusal writes nothing");

    let plain = notes.adopt(&["--kind", "journal", "--no-encrypt", "--no-git"]);
    assert_eq!(code(&plain), 0, "{}", text(&plain));
    let verified = notes.fjord(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", text(&verified));
}

#[test]
fn encrypting_what_is_already_there_goes_through_a_checkout_nothing_commits_past() {
    let dir = Directory::new();
    dir.write("journal/2026-11-02.md", "Dear diary\n");
    dir.with_history();

    let adopted = dir.adopt(&["--kind", "journal", "--encrypt-existing"]);
    assert_eq!(code(&adopted), 0, "{}", text(&adopted));
    // The warning that history keeps what was committed, said before anything else.
    assert!(text(&adopted).contains("history"), "{}", text(&adopted));
    // No commit was made: a checkout forbids it.
    assert_eq!(dir.git(&["log", "--format=%s"]).trim(), "before Fjord");
    // The checkout is recorded, and it is local: ignored by git.
    assert!(dir.root.join(".fjord/local/checkouts").is_dir());
    assert!(dir
        .git(&["status", "--short"])
        .lines()
        .all(|l| !l.contains(".fjord")));
    // The files are, until checked in, in the clear and said to be.
    assert_eq!(
        std::fs::read_to_string(dir.root.join("journal/2026-11-02.md")).unwrap(),
        "Dear diary\n"
    );

    // Nothing that commits will.
    let synced = dir.fjord(&["sync"]);
    assert_ne!(code(&synced), 0, "{}", text(&synced));

    // A key, then check-in: the plaintext is gone and the entry is an encrypted payload.
    let identity = dir.config.join("identity.txt");
    let made = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["--no-input", "key", "new", "--out"])
        .arg(&identity)
        .env("FJORD_CONFIG_DIR", &dir.config)
        .current_dir(&dir.config)
        .output()
        .expect("key new");
    assert_eq!(code(&made), 0, "{}", text(&made));
    let public = std::fs::read_to_string(&identity)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("# public key: "))
        .expect("a public key comment")
        .to_string();
    let added = dir.fjord(&["key", "add", &public, "--vault", "journal"]);
    assert_eq!(code(&added), 0, "{}", text(&added));
    let identity_arg = identity.to_string_lossy().to_string();
    let checked_in = dir.fjord(&["--identity", &identity_arg, "encrypt", "journal"]);
    assert_eq!(code(&checked_in), 0, "{}", text(&checked_in));

    assert!(!dir.root.join("journal/2026-11-02.md").exists());
    assert!(
        dir.snapshot()
            .values()
            .all(|bytes| !String::from_utf8_lossy(bytes).contains("Dear diary")),
        "no plaintext of the entry is left anywhere in the directory"
    );
    let verified = dir.fjord(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", text(&verified));
    // And the history still holds it, which is what the warning said.
    let history = dir.git(&["show", "HEAD:journal/2026-11-02.md"]);
    assert_eq!(history, "Dear diary\n");
}

#[test]
fn a_directory_that_is_a_fjord_repository_already_is_refused() {
    let dir = Directory::new();
    dir.write("fjord.json", "{}\n");
    dir.write("notes/a.md", "A\n");
    let before = dir.snapshot();
    let refused = dir.adopt(&["--vault", "notes", "--no-git"]);
    assert_eq!(code(&refused), 2, "{}", text(&refused));
    assert_eq!(dir.snapshot(), before);
}

#[test]
fn the_vault_flags_mean_nothing_without_adopt_and_adopt_needs_a_directory() {
    let dir = Directory::new();
    let root = dir.root.to_string_lossy().to_string();
    for arguments in [
        vec!["--no-input", "init", &root, "--vault", "notes"],
        vec!["--no-input", "init", &root, "--encrypt-existing"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
            .args(&arguments)
            .output()
            .expect("run");
        assert_eq!(code(&output), 2, "{arguments:?}: {}", text(&output));
    }
    let missing = dir.root.join("nowhere").to_string_lossy().to_string();
    let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["--no-input", "init", &missing, "--adopt"])
        .output()
        .expect("run");
    assert_eq!(code(&output), 2, "{}", text(&output));
}

#[test]
fn a_flag_that_disagrees_with_the_kind_is_refused_before_anything_is_written() {
    let dir = Directory::new();
    dir.write("content/a.md", "A\n");
    let before = dir.snapshot();
    for arguments in [
        vec![
            "--kind",
            "ssg",
            "--engine",
            "astro",
            "--vault",
            "content",
            "--encrypt-existing",
        ],
        vec!["--vault", "content", "--no-encrypt", "--encrypt-existing"],
        vec!["--vault", "../outside"],
        vec!["--vault", "content", "--vault", "content/sub"],
    ] {
        let mut all = arguments.clone();
        all.push("--no-git");
        let output = dir.adopt(&all);
        assert_eq!(code(&output), 2, "{arguments:?}: {}", text(&output));
        assert_eq!(dir.snapshot(), before, "{arguments:?} wrote something");
    }
}

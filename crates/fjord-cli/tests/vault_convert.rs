// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord encrypt <vault> --permanent` and `fjord decrypt <vault> --permanent`: a vault made encrypted in one command, worked on, and made plaintext
//! again (RFC 0003, spec §6.7).
//!
//! What is held here: no plaintext of an encrypted vault is left on disk or committed, every payload opens to what it was
//! made from, the vault keeps its id and the fields it has that we do not know, and the history says what it said.

use std::path::PathBuf;
use std::process::{Command, Output};

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn code(output: &Output) -> i32 {
    output.status.code().unwrap_or(-1)
}

impl Repo {
    /// A drive whose vaults are both plaintext, with a note in the Private one, committed.
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("repo");
        let config = temp.path().join("config");
        std::fs::create_dir(&config).expect("mkdir");
        let repo = Repo {
            root: root.clone(),
            config,
            _temp: temp,
        };
        let made = Command::new(env!("CARGO_BIN_EXE_fjord"))
            .args(["--no-input", "init"])
            .arg(&root)
            .arg("--no-encrypt")
            .env("FJORD_CONFIG_DIR", &repo.config)
            .env("NO_COLOR", "1")
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .expect("init");
        assert_eq!(code(&made), 0, "{}", text(&made));
        let root = std::fs::canonicalize(&repo.root).expect("canonical");
        Repo { root, ..repo }
    }

    fn write(&self, relative: &str, contents: &str) {
        let path = self.root.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, contents).expect("write");
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
            .expect("fjord")
    }

    fn git(&self, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(&self.root)
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            text(&output)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    /// An identity in the config directory, which is where every command looks for one.
    fn identity(&self) -> String {
        let path = self.config.join("identity.txt");
        let made = Command::new(env!("CARGO_BIN_EXE_fjord"))
            .args(["--no-input", "key", "new", "--out"])
            .arg(&path)
            .env("FJORD_CONFIG_DIR", &self.config)
            .current_dir(&self.config)
            .output()
            .expect("key new");
        assert_eq!(code(&made), 0, "{}", text(&made));
        std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("# public key: "))
            .expect("a public key comment")
            .to_string()
    }

    fn files(&self, vault: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut stack = vec![self.root.join(vault)];
        while let Some(directory) = stack.pop() {
            for entry in std::fs::read_dir(&directory).expect("read_dir").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    found.push(
                        path.strip_prefix(self.root.join(vault))
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        found.sort();
        found
    }
}

const SECRET: &str = "the launch is on the 14th\n";

fn repo_with_notes() -> Repo {
    let repo = Repo::new();
    repo.write("Private/plan.md", SECRET);
    repo.write("Private/Deep/more.md", "deeper\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "notes"]);
    repo
}

#[test]
fn a_plaintext_vault_is_made_encrypted_in_one_command_and_made_plaintext_again() {
    let repo = repo_with_notes();
    let public = repo.identity();
    let manifest_before: serde_json::Value =
        serde_json::from_slice(&std::fs::read(repo.root.join("Private/fjord.vault.json")).unwrap())
            .unwrap();

    // One command, with the identity's own key as the recipient.
    let encrypted = repo.fjord(&["encrypt", "Private", "--permanent", "--yes", "--commit"]);
    assert_eq!(code(&encrypted), 0, "{}", text(&encrypted));
    assert_eq!(
        repo.files("Private"),
        [
            ".gitignore",
            "Deep/more.md.age",
            "fjord.vault.json",
            "plan.md.age",
            "recipients.txt"
        ]
    );
    assert!(
        std::fs::read_to_string(repo.root.join("Private/recipients.txt"))
            .unwrap()
            .contains(&public)
    );

    // The vault is the same vault: its id, and the fields it has that nothing here knows.
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(repo.root.join("Private/fjord.vault.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["id"], manifest_before["id"]);
    assert_eq!(manifest["encryption"]["tool"], "age");

    // No plaintext on disk, and none in what was committed (the history keeps what it had, as was said).
    let tracked = repo.git(&["ls-files", "Private"]);
    assert!(
        !tracked.contains("plan.md\n") && tracked.contains("plan.md.age"),
        "{tracked}"
    );
    assert_eq!(
        repo.git(&["log", "-1", "--format=%s"]).trim(),
        "Encrypt vault Private"
    );
    assert_eq!(repo.git(&["show", "HEAD~1:Private/plan.md"]), SECRET);
    let verified = repo.fjord(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", text(&verified));
    assert_eq!(repo.git(&["status", "--porcelain"]), "");

    // Work on it, and put it back.
    let out = repo.fjord(&["decrypt", "Private"]);
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(
        std::fs::read_to_string(repo.root.join("Private/plan.md")).unwrap(),
        SECRET
    );
    repo.write("Private/plan.md", "the launch moved to the 21st\n");
    let back = repo.fjord(&["encrypt", "Private"]);
    assert_eq!(code(&back), 0, "{}", text(&back));
    assert!(!repo.root.join("Private/plan.md").exists());

    // And later, plaintext for good.
    let plain = repo.fjord(&["decrypt", "Private", "--permanent", "--yes", "--commit"]);
    assert_eq!(code(&plain), 0, "{}", text(&plain));
    assert_eq!(
        repo.files("Private"),
        ["Deep/more.md", "fjord.vault.json", "plan.md"]
    );
    assert_eq!(
        std::fs::read_to_string(repo.root.join("Private/plan.md")).unwrap(),
        "the launch moved to the 21st\n"
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(repo.root.join("Private/fjord.vault.json")).unwrap())
            .unwrap();
    assert!(manifest["encryption"].is_null());
    assert_eq!(manifest["id"], manifest_before["id"]);
    assert_eq!(
        repo.git(&["log", "-1", "--format=%s"]).trim(),
        "Decrypt vault Private"
    );
    let verified = repo.fjord(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", text(&verified));
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}

#[test]
fn encrypting_needs_someone_to_encrypt_to_and_an_answer_to_the_question() {
    let repo = repo_with_notes();
    let before = repo.git(&["rev-parse", "HEAD"]);

    // No identity and no --recipient: nobody to write it, so nothing is touched.
    let nobody = repo.fjord(&["encrypt", "Private", "--permanent", "--yes"]);
    assert_eq!(code(&nobody), 2, "{}", text(&nobody));
    assert!(text(&nobody).contains("fjord key new"), "{}", text(&nobody));

    // With a key but with no one to ask and no --yes: the same.
    repo.identity();
    let unasked = repo.fjord(&["encrypt", "Private", "--permanent"]);
    assert_ne!(code(&unasked), 0, "{}", text(&unasked));
    assert!(text(&unasked).contains("--yes"), "{}", text(&unasked));

    assert_eq!(
        repo.files("Private"),
        ["fjord.vault.json", "plan.md", "Deep/more.md"]
            .iter()
            .map(|s| s.to_string())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    );
    assert!(!repo.root.join("Private/recipients.txt").exists());
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), before);
    assert!(
        !repo.root.join(".fjord/local/checkouts").exists()
            || std::fs::read_dir(repo.root.join(".fjord/local/checkouts"))
                .unwrap()
                .next()
                .is_none()
    );
}

#[test]
fn a_vault_that_is_already_what_was_asked_for_is_not_touched() {
    let repo = repo_with_notes();
    repo.identity();
    let decrypt = repo.fjord(&["decrypt", "Private", "--permanent", "--yes"]);
    assert_eq!(code(&decrypt), 2, "{}", text(&decrypt));
    assert!(
        text(&decrypt).contains("not encrypted"),
        "{}",
        text(&decrypt)
    );

    let encrypted = repo.fjord(&["encrypt", "Private", "--permanent", "--yes"]);
    assert_eq!(code(&encrypted), 0, "{}", text(&encrypted));
    let again = repo.fjord(&["encrypt", "Private", "--permanent", "--yes"]);
    assert_eq!(code(&again), 2, "{}", text(&again));
    assert!(
        text(&again).contains("already encrypted"),
        "{}",
        text(&again)
    );
    let missing = repo.fjord(&["encrypt", "Nowhere", "--permanent", "--yes"]);
    assert_eq!(code(&missing), 2, "{}", text(&missing));
}

#[test]
fn a_site_is_never_encrypted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("site");
    let config = temp.path().join("config");
    std::fs::create_dir(&config).unwrap();
    let made = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["--no-input", "init"])
        .arg(&root)
        .args(["--kind", "ssg", "--engine", "astro"])
        .env("FJORD_CONFIG_DIR", &config)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
        .output()
        .unwrap();
    assert_eq!(code(&made), 0, "{}", text(&made));
    let refused = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["--no-input", "-C"])
        .arg(&root)
        .args([
            "vault",
            "encrypt",
            "content",
            "--yes",
            "--recipient",
            "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnjnfn6",
        ])
        .env("FJORD_CONFIG_DIR", &config)
        .output()
        .unwrap();
    assert_eq!(code(&refused), 2, "{}", text(&refused));
}

/// Without `--permanent`, `decrypt` and `encrypt` on a vault are the checkout: the vault stays what it is, nothing commits or
/// syncs meanwhile, and checking it in leaves it encrypted (spec §6.6).
#[test]
fn decrypting_a_vault_without_the_flag_is_only_for_editing_and_nothing_commits_meanwhile() {
    let repo = repo_with_notes();
    repo.identity();
    let encrypted = repo.fjord(&["encrypt", "Private", "--permanent", "--yes"]);
    assert_eq!(code(&encrypted), 0, "{}", text(&encrypted));
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "encrypted"]);
    let head = repo.git(&["rev-parse", "HEAD"]);
    let manifest = std::fs::read(repo.root.join("Private/fjord.vault.json")).unwrap();

    let out = repo.fjord(&["decrypt", "Private"]);
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(
        std::fs::read_to_string(repo.root.join("Private/plan.md")).unwrap(),
        SECRET
    );
    // Still an encrypted vault, with its payloads where they were.
    assert_eq!(
        std::fs::read(repo.root.join("Private/fjord.vault.json")).unwrap(),
        manifest
    );
    assert!(repo.root.join("Private/plan.md.age").exists());

    // Nothing commits, syncs or converts while it is out - this vault's or another's.
    repo.write("Public/hello.md", "hello\n");
    for arguments in [
        vec!["sync"],
        vec!["rekey", "Private", "--yes"],
        vec!["vault", "add", "Other", "--commit"],
        vec!["open", "Public/hello.md", "--commit", "--editor", "true"],
        vec!["decrypt", "Private", "--permanent", "--yes"],
        vec!["encrypt", "Private", "--permanent", "--yes"],
    ] {
        let refused = repo.fjord(&arguments);
        assert_ne!(code(&refused), 0, "{arguments:?}: {}", text(&refused));
    }
    assert_eq!(
        repo.git(&["rev-parse", "HEAD"]),
        head,
        "nothing was committed"
    );

    // Checked back in, it is the same encrypted vault.
    repo.write("Private/plan.md", "the launch moved\n");
    let back = repo.fjord(&["encrypt", "Private"]);
    assert_eq!(code(&back), 0, "{}", text(&back));
    assert!(!repo.root.join("Private/plan.md").exists());
    let manifest_after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(repo.root.join("Private/fjord.vault.json")).unwrap())
            .unwrap();
    assert_eq!(manifest_after["encryption"]["tool"], "age");
}

/// The flags that only mean something with `--permanent` are refused without it, and the other way round.
#[test]
fn the_permanent_flags_are_refused_where_they_do_not_belong() {
    let repo = repo_with_notes();
    repo.identity();
    for arguments in [
        vec!["encrypt", "Private", "--commit"],
        vec![
            "encrypt",
            "Private",
            "--recipient",
            "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnjnfn6",
        ],
        vec!["encrypt", "Private/plan.md", "--permanent"],
        vec!["decrypt", "Private", "--yes"],
        vec!["encrypt", "Private", "--permanent", "--dry-run"],
    ] {
        let refused = repo.fjord(&arguments);
        assert_eq!(code(&refused), 2, "{arguments:?}: {}", text(&refused));
    }
    assert!(!repo.root.join("Private/recipients.txt").exists());
}

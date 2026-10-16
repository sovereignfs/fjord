//! `fjord rekey`. Spec §6.2, §11.4.
//!
//! The point of the command is the first test: age encrypts to the
//! recipients present when a file is written, so a key added later cannot
//! read anything older. `rekey` is what closes that gap, and it is the only
//! reason `fjord key add` tells people the gap exists.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    /// Held only so the directory outlives the test: dropping it deletes
    /// everything the test is looking at.
    _temp: tempfile::TempDir,
    root: PathBuf,
    /// The identity the vault starts with.
    first: PathBuf,
    /// A second identity, standing in for a new device.
    second: PathBuf,
}

fn fjord(root: &Path, config: &Path, arguments: &[&str]) -> Output {
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
        .env_remove("EDITOR");
    command.output().expect("run fjord")
}

impl Repo {
    /// As the machine that set the vault up.
    fn owner(&self, arguments: &[&str]) -> Output {
        fjord(&self.root, &self.first, arguments)
    }

    /// As the machine whose key was added later.
    fn newcomer(&self, arguments: &[&str]) -> Output {
        fjord(&self.root, &self.second, arguments)
    }

    fn public_key(&self, config: &Path) -> String {
        let text = std::fs::read_to_string(config.join("identity.txt")).expect("read");
        text.lines()
            .find_map(|line| line.strip_prefix("# public key: "))
            .expect("a public key comment")
            .to_string()
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

/// A repository whose `Private` vault holds documents written to one key
/// only, plus a second identity that has never been a recipient.
fn repo() -> Repo {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let first = temp.path().join("first");
    let second = temp.path().join("second");

    for config in [&first, &second] {
        let generated = Command::new(env!("CARGO_BIN_EXE_fjord"))
            .args(["key", "new"])
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", config)
            .current_dir(temp.path())
            .output()
            .expect("key new");
        assert_eq!(generated.status.code(), Some(0), "{}", err(&generated));
    }

    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(init.status.code(), Some(0), "{}", err(&init));

    let repo = Repo {
        _temp: temp,
        root,
        first,
        second,
    };

    let owner_key = repo.public_key(&repo.first);
    let added = repo.owner(&["key", "add", &owner_key, "--vault", "Private"]);
    assert_eq!(code(&added), 0, "{}", err(&added));

    repo
}

// --- The reason the command exists ---------------------------------------

/// §6.2: age encrypts to the recipients present at write time, so a key
/// added afterwards reads nothing older. This is the gap `rekey` closes.
#[test]
fn a_newly_added_key_can_read_old_documents_only_after_rekey() {
    let repo = repo();

    // Written when only the first key was a recipient.
    assert_eq!(
        code(&repo.owner(&["new", "Private/old.md", "--title", "Older", "--no-edit"])),
        0
    );

    // The newcomer's key is added, but that grants nothing retroactively.
    let newcomer_key = repo.public_key(&repo.second);
    let added = repo.owner(&["key", "add", &newcomer_key, "--vault", "Private"]);
    assert_eq!(code(&added), 0, "{}", err(&added));
    assert!(
        out(&added).contains("does not grant access"),
        "the caveat should be stated: {}",
        out(&added)
    );

    let before = repo.newcomer(&["decrypt", "Private/old.md.age"]);
    assert_ne!(
        code(&before),
        0,
        "the new key should not read a document written before it: {}",
        out(&before)
    );

    // Rekey, and it can.
    let rekeyed = repo.owner(&["rekey", "Private", "--yes"]);
    assert_eq!(code(&rekeyed), 0, "{}{}", out(&rekeyed), err(&rekeyed));
    assert!(out(&rekeyed).contains("re-encrypted"), "{}", out(&rekeyed));

    let after = repo.newcomer(&["decrypt", "Private/old.md.age"]);
    assert_eq!(code(&after), 0, "{}", err(&after));
    assert!(out(&after).contains("title: Older"), "{}", out(&after));

    // And the original key still reads it: every recipient, not the newest.
    let owner = repo.owner(&["decrypt", "Private/old.md.age"]);
    assert_eq!(code(&owner), 0, "{}", err(&owner));
    assert!(out(&owner).contains("title: Older"));

    assert_eq!(code(&repo.owner(&["verify"])), 0);
}

/// §11.4 is a MUST wherever a user might infer revocation, and
/// "re-encrypted to the current list" is exactly such a place.
#[test]
fn rekey_says_it_revokes_nothing() {
    let repo = repo();
    assert_eq!(code(&repo.owner(&["new", "Private/a.md", "--no-edit"])), 0);

    let rekeyed = repo.owner(&["rekey", "Private", "--yes"]);
    let printed = out(&rekeyed);
    assert!(printed.contains("revokes nothing"), "{printed}");
    assert!(printed.contains("permanently"), "{printed}");
    assert!(printed.contains("history"), "{printed}");
}

/// Re-encrypting to a list without one of your own keys would make every
/// document permanently unreadable, and §11.4 leaves no way back.
#[test]
fn rekey_refuses_to_lock_you_out() {
    let repo = repo();
    assert_eq!(code(&repo.owner(&["new", "Private/a.md", "--no-edit"])), 0);
    let payload_before = std::fs::read(repo.root.join("Private/a.md.age")).expect("read");

    // Replace the recipient list with a key nobody here holds.
    let newcomer_key = repo.public_key(&repo.second);
    let added = repo.owner(&["key", "add", &newcomer_key, "--vault", "Private"]);
    assert_eq!(code(&added), 0);
    let owner_key = repo.public_key(&repo.first);
    let removed = repo.owner(&["key", "remove", &owner_key, "--vault", "Private"]);
    assert_eq!(code(&removed), 0, "{}", err(&removed));

    // The owner's identity is no longer a recipient, so this must refuse.
    let refused = repo.owner(&["rekey", "Private", "--yes"]);
    assert_eq!(code(&refused), 2, "{}{}", out(&refused), err(&refused));
    assert!(err(&refused).contains("§11.4"), "{}", err(&refused));
    assert!(err(&refused).contains("key add"), "{}", err(&refused));

    // Nothing was touched.
    assert_eq!(
        std::fs::read(repo.root.join("Private/a.md.age")).expect("read"),
        payload_before,
        "a refused rekey must not have rewritten anything"
    );
}

// --- Behaviour ------------------------------------------------------------

#[test]
fn every_document_is_rewritten_in_one_commit() {
    let repo = repo();
    for name in ["one.md", "two.md", "Nested/three.md"] {
        assert_eq!(
            code(&repo.owner(&["new", &format!("Private/{name}"), "--no-edit"])),
            0
        );
    }
    // Commit the documents, so the rekey commit stands alone.
    assert!(Command::new("git")
        .current_dir(&repo.root)
        .args(["add", "-A"])
        .status()
        .expect("git add")
        .success());
    assert!(Command::new("git")
        .current_dir(&repo.root)
        .args(["commit", "-q", "-m", "Add documents"])
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .status()
        .expect("git commit")
        .success());

    let before: Vec<Vec<u8>> = ["one.md", "two.md", "Nested/three.md"]
        .iter()
        .map(|name| std::fs::read(repo.root.join(format!("Private/{name}.age"))).expect("read"))
        .collect();

    let rekeyed = repo.owner(&["rekey", "Private", "--yes"]);
    assert_eq!(code(&rekeyed), 0, "{}{}", out(&rekeyed), err(&rekeyed));
    assert!(out(&rekeyed).contains("3 documents"), "{}", out(&rekeyed));

    // Every payload is different — age output is non-deterministic, so this
    // is what "rewritten" looks like — and every one still decrypts.
    for (index, name) in ["one.md", "two.md", "Nested/three.md"].iter().enumerate() {
        let path = repo.root.join(format!("Private/{name}.age"));
        let after = std::fs::read(&path).expect("read");
        assert_ne!(after, before[index], "{name} was not rewritten");

        let decrypted = repo.owner(&["decrypt", &format!("Private/{name}.age")]);
        assert_eq!(code(&decrypted), 0, "{name}: {}", err(&decrypted));
        assert!(out(&decrypted).starts_with("---\n"), "{name} is not a Doc");
    }

    // One commit, naming the vault.
    let log = Command::new("git")
        .current_dir(&repo.root)
        .args(["log", "--oneline"])
        .output()
        .expect("git log");
    let log = String::from_utf8_lossy(&log.stdout);
    assert!(
        log.lines().next().unwrap_or("").contains("Rekey Private"),
        "{log}"
    );
    assert_eq!(log.lines().count(), 3, "expected one rekey commit:\n{log}");

    // And the tree is clean: no staged leftovers, no `.tmp` files.
    let status = Command::new("git")
        .current_dir(&repo.root)
        .args(["status", "--porcelain"])
        .output()
        .expect("git status");
    assert_eq!(
        String::from_utf8_lossy(&status.stdout).trim(),
        "",
        "the working tree should be clean after a rekey"
    );
}

#[test]
fn an_id_vault_keeps_its_names_and_its_filenames() {
    // §7.2: the leaf is the identifier, and the real name lives in the
    // container. Both must survive a rekey.
    let repo = repo();
    let created = repo.owner(&["vault", "add", "Secret", "--encrypted", "--id-naming"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    let owner_key = repo.public_key(&repo.first);
    assert_eq!(
        code(&repo.owner(&["key", "add", &owner_key, "--vault", "Secret"])),
        0
    );
    assert_eq!(
        code(&repo.owner(&["new", "Secret/my report.md", "--no-edit"])),
        0
    );

    let names_before: Vec<String> = std::fs::read_dir(repo.root.join("Secret"))
        .expect("read")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".age"))
        .collect();
    assert_eq!(names_before.len(), 1);

    assert_eq!(code(&repo.owner(&["rekey", "Secret", "--yes"])), 0);

    // The file is still named by its id...
    let names_after: Vec<String> = std::fs::read_dir(repo.root.join("Secret"))
        .expect("read")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".age"))
        .collect();
    assert_eq!(names_after, names_before, "the id-named file was renamed");

    // ...and the container still knows what it is really called.
    let listed = repo.owner(&["ls", "Secret", "--long"]);
    assert_eq!(code(&listed), 0, "{}", err(&listed));
    assert!(out(&listed).contains("my report.md"), "{}", out(&listed));

    assert_eq!(code(&repo.owner(&["verify"])), 0);
}

#[test]
fn a_file_in_the_clear_is_left_for_encrypt_to_deal_with() {
    // Encrypting it here would change its name on disk, which is not what
    // "re-encrypt the vault" means.
    let repo = repo();
    assert_eq!(code(&repo.owner(&["new", "Private/a.md", "--no-edit"])), 0);
    std::fs::write(repo.root.join("Private/stray.md"), "in the clear\n").expect("write");

    let rekeyed = repo.owner(&["rekey", "Private", "--yes"]);
    assert_eq!(code(&rekeyed), 0, "{}{}", out(&rekeyed), err(&rekeyed));
    assert!(out(&rekeyed).contains("E201"), "{}", out(&rekeyed));
    assert_eq!(
        std::fs::read_to_string(repo.root.join("Private/stray.md")).expect("read"),
        "in the clear\n",
        "the file should be untouched, not encrypted"
    );
}

// --- Refusals -------------------------------------------------------------

#[test]
fn a_plaintext_vault_has_nothing_to_re_encrypt() {
    let repo = repo();
    let refused = repo.owner(&["rekey", "Public"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("not encrypted"), "{}", err(&refused));
}

#[test]
fn an_unknown_vault_is_refused() {
    let repo = repo();
    let refused = repo.owner(&["rekey", "Nonexistent"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("vault list"), "{}", err(&refused));
}

#[test]
fn a_vault_with_no_recipients_is_refused() {
    let repo = repo();
    std::fs::write(repo.root.join("Private/recipients.txt"), "# none\n").expect("write");
    let refused = repo.owner(&["rekey", "Private"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("no recipients"), "{}", err(&refused));
}

#[test]
fn an_empty_vault_is_not_an_error() {
    let repo = repo();
    let rekeyed = repo.owner(&["rekey", "Private", "--yes"]);
    assert_eq!(code(&rekeyed), 0, "{}", err(&rekeyed));
    assert!(
        out(&rekeyed).contains("nothing to re-encrypt"),
        "{}",
        out(&rekeyed)
    );
}

#[test]
fn confirmation_is_required_and_no_input_says_so_rather_than_hanging() {
    let repo = repo();
    assert_eq!(code(&repo.owner(&["new", "Private/a.md", "--no-edit"])), 0);
    let before = std::fs::read(repo.root.join("Private/a.md.age")).expect("read");

    // Not a terminal, and no --yes: it must refuse rather than wait.
    let refused = repo.owner(&["rekey", "Private"]);
    assert_ne!(code(&refused), 0);
    assert!(err(&refused).contains("--yes"), "{}", err(&refused));

    let refused = repo.owner(&["rekey", "Private", "--no-input"]);
    assert_ne!(code(&refused), 0);
    assert!(err(&refused).contains("--yes"), "{}", err(&refused));

    assert_eq!(
        std::fs::read(repo.root.join("Private/a.md.age")).expect("read"),
        before
    );
}

#[test]
fn a_newer_repository_is_never_rekeyed() {
    // Invariant 4: rekey writes.
    let repo = repo();
    assert_eq!(code(&repo.owner(&["new", "Private/a.md", "--no-edit"])), 0);
    let manifest = repo.root.join("fjord.json");
    let contents = std::fs::read_to_string(&manifest).expect("read");
    std::fs::write(&manifest, contents.replace("\"fjord\": 1", "\"fjord\": 2")).expect("write");

    let refused = repo.owner(&["rekey", "Private", "--yes"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("version 2"), "{}", err(&refused));
}

/// Keep `Path` referenced for the helpers above.
#[allow(dead_code)]
fn _path(_: &Path) {}

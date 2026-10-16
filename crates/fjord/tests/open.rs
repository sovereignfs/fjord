//! `fjord open`, and the four things CLAUDE.md requires it to get right.
//!
//! Each has a test named after it:
//!
//! - `a_forking_editor_is_made_to_wait`
//! - `an_unchanged_document_is_not_re_encrypted`
//! - `a_terminated_session_leaves_no_plaintext`
//! - `a_second_session_is_refused`
//!
//! The editors are shell scripts, which is what makes this testable: a real
//! editor needs a terminal, while `#!/bin/sh` can stand in for one that
//! saves, one that changes nothing, and one that hangs.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Repo {
    temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
    /// Where decrypted scratch files land, so a test can watch them.
    scratch: PathBuf,
}

impl Repo {
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("TMPDIR", &self.scratch)
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .env_remove("EDITOR")
            .env_remove("VISUAL");
        command
    }

    fn run(&self, arguments: &[&str]) -> Output {
        self.command().args(arguments).output().expect("run fjord")
    }

    /// Files left in the scratch directory. After any session this must be
    /// empty: §11.3 makes removing them a MUST.
    fn scratch_files(&self) -> Vec<String> {
        let mut found = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.scratch) {
            for entry in entries.flatten() {
                found.push(entry.file_name().to_string_lossy().to_string());
            }
        }
        found.sort();
        found
    }

    fn locks(&self) -> Vec<String> {
        let mut found = Vec::new();
        let directory = self.root.join(".fjord/local/locks");
        if let Ok(entries) = std::fs::read_dir(&directory) {
            for entry in entries.flatten() {
                found.push(entry.file_name().to_string_lossy().to_string());
            }
        }
        found.sort();
        found
    }

    fn payload(&self) -> PathBuf {
        self.root.join("Private/notes.md.age")
    }

    fn identity(&self) -> PathBuf {
        self.config.join("identity.txt")
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

/// A repository with a key, holding one encrypted document.
fn repo_with_document(contents: &str) -> Repo {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let config = temp.path().join("config");
    let scratch = temp.path().join("scratch");
    std::fs::create_dir_all(&scratch).expect("create scratch");

    let base = Repo {
        temp,
        root,
        config,
        scratch,
    };

    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &base.root.to_string_lossy()])
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
        .env("FJORD_CONFIG_DIR", &base.config)
        .current_dir(base.temp.path())
        .output()
        .expect("key new");
    assert_eq!(generated.status.code(), Some(0), "{}", err(&generated));
    let report: serde_json::Value = serde_json::from_str(&out(&generated)).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();

    let added = base.run(&["key", "add", &recipient, "--vault", "Private"]);
    assert_eq!(code(&added), 0, "{}", err(&added));

    let source = base.root.join("Private/notes.md");
    std::fs::write(&source, contents).expect("write");
    let encrypted = base.run(&["encrypt", &source.to_string_lossy()]);
    assert_eq!(code(&encrypted), 0, "{}", err(&encrypted));

    base
}

/// Write an executable stand-in for an editor.
fn editor_script(repo: &Repo, name: &str, body: &str) -> PathBuf {
    let path = repo.temp.path().join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    path
}

// --- The acceptance criteria ---------------------------------------------

/// A GUI editor that forks would end the session before the window opened.
#[test]
fn a_forking_editor_is_made_to_wait() {
    // The resolution logic is unit-tested in `cmd::open`; this checks the
    // consequence end to end. The script records the arguments it was given.
    let repo = repo_with_document("original\n");
    let log = repo.temp.path().join("arguments.txt");
    let editor = editor_script(
        &repo,
        "code",
        &format!("printf '%s\\n' \"$@\" > {}", log.display()),
    );

    let output = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 0, "{}", err(&output));

    let recorded = std::fs::read_to_string(&log).expect("read log");
    let arguments: Vec<&str> = recorded.lines().collect();
    assert_eq!(
        arguments.len(),
        2,
        "expected --wait plus the file, got {arguments:?}"
    );
    assert_eq!(
        arguments[0], "--wait",
        "a forking editor was not made to wait"
    );
}

/// age output is non-deterministic, so re-encrypting an unchanged document
/// would write an entirely new object Git cannot delta-compress.
#[test]
fn an_unchanged_document_is_not_re_encrypted() {
    let repo = repo_with_document("original\n");
    let before = std::fs::read(repo.payload()).expect("read payload");

    // An editor that opens the file and changes nothing.
    let editor = editor_script(&repo, "noop", "exit 0");
    let output = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);

    assert_eq!(code(&output), 0, "{}", err(&output));
    assert!(out(&output).contains("unchanged"), "{}", out(&output));
    assert_eq!(
        std::fs::read(repo.payload()).expect("read payload"),
        before,
        "the payload was rewritten despite no change"
    );
    assert!(repo.scratch_files().is_empty(), "plaintext was left behind");
    assert!(repo.locks().is_empty(), "the lock was not released");
}

/// Spec §11.3: temporary decrypted files MUST be removed when a session
/// ends. An interrupted session is still an ended one.
#[cfg(unix)]
#[test]
fn a_terminated_session_leaves_no_plaintext() {
    let repo = repo_with_document("original\n");

    // An editor that hangs, so the session is still open when the signal
    // arrives.
    let editor = editor_script(&repo, "hang", "sleep 30");
    let mut child = repo
        .command()
        .args([
            "open",
            "Private/notes.md",
            "--editor",
            &editor.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fjord open");

    // Wait for the decrypted file to exist, so the test is about cleanup
    // rather than about timing.
    let deadline = Instant::now() + Duration::from_secs(60);
    while repo.scratch_files().is_empty() {
        assert!(
            Instant::now() < deadline,
            "the decrypted file never appeared"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    let during = repo.scratch_files();
    assert_eq!(during.len(), 1, "expected one scratch file, got {during:?}");
    assert!(!repo.locks().is_empty(), "no lock was taken");

    assert!(Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .expect("kill")
        .success());

    let status = child.wait().expect("wait");
    assert_eq!(status.code(), Some(130), "expected the SIGINT convention");

    assert!(
        repo.scratch_files().is_empty(),
        "a terminated session left plaintext at {:?}",
        repo.scratch_files()
    );
    assert!(
        repo.locks().is_empty(),
        "a terminated session kept its lock"
    );

    // And the document is untouched.
    let output = Command::new("age")
        .args(["-d", "-i"])
        .arg(repo.identity())
        .arg(repo.payload())
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            assert_eq!(String::from_utf8_lossy(&output.stdout), "original\n");
        }
    }
}

/// Two sessions on one document means one set of edits is lost.
#[cfg(unix)]
#[test]
fn a_second_session_is_refused() {
    let repo = repo_with_document("original\n");
    let editor = editor_script(&repo, "hang", "sleep 30");

    let mut first = repo
        .command()
        .args([
            "open",
            "Private/notes.md",
            "--editor",
            &editor.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the first session");

    let deadline = Instant::now() + Duration::from_secs(60);
    while repo.locks().is_empty() {
        assert!(Instant::now() < deadline, "the lock never appeared");
        std::thread::sleep(Duration::from_millis(25));
    }

    let second = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&second), 2, "a second session was allowed");
    assert!(err(&second).contains("already open"), "{}", err(&second));
    assert!(err(&second).contains("pid"), "{}", err(&second));

    let _ = Command::new("kill")
        .args(["-TERM", &first.id().to_string()])
        .status();
    let _ = first.wait();

    // Once the first session ends, a new one is fine.
    let noop = editor_script(&repo, "noop", "exit 0");
    let third = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &noop.to_string_lossy(),
    ]);
    assert_eq!(code(&third), 0, "{}", err(&third));
}

// --- The ordinary path ---------------------------------------------------

#[test]
fn an_edit_is_re_encrypted_and_still_readable_by_age() {
    let repo = repo_with_document("original\n");
    let editor = editor_script(&repo, "append", "printf 'edited\\n' >> \"$1\"");

    let output = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 0, "{}", err(&output));
    assert!(out(&output).contains("re-encrypted"), "{}", out(&output));

    // No plaintext anywhere, and the repository still conforms.
    assert!(repo.scratch_files().is_empty());
    assert!(!repo.root.join("Private/notes.md").exists());
    assert_eq!(code(&repo.run(&["verify"])), 0);

    // The edit survived, and the reference implementation can read it.
    let age = Command::new("age")
        .args(["-d", "-i"])
        .arg(repo.identity())
        .arg(repo.payload())
        .output();
    match age {
        Ok(age) if age.status.success() => {
            assert_eq!(String::from_utf8_lossy(&age.stdout), "original\nedited\n");
        }
        _ => {
            // No `age` binary: fall back to our own reader.
            let decrypted = repo.run(&["decrypt", &repo.payload().to_string_lossy()]);
            assert_eq!(out(&decrypted), "original\nedited\n");
        }
    }
}

#[test]
fn the_logical_name_finds_the_payload() {
    // A user should not have to type `.age`.
    let repo = repo_with_document("original\n");
    let editor = editor_script(&repo, "noop", "exit 0");

    for name in ["Private/notes.md", "Private/notes.md.age"] {
        let output = repo.run(&["open", name, "--editor", &editor.to_string_lossy()]);
        assert_eq!(code(&output), 0, "{name}: {}", err(&output));
        // Probing the payload name must not leave an error behind on the
        // way to a success: resolution is side-effect free, and printing is
        // the caller's job.
        assert_eq!(
            err(&output),
            "",
            "{name} succeeded but wrote to stderr: {}",
            err(&output)
        );
    }
}

#[test]
fn the_scratch_file_keeps_the_extension_the_editor_needs() {
    let repo = repo_with_document("original\n");
    let log = repo.temp.path().join("name.txt");
    let editor = editor_script(
        &repo,
        "record",
        &format!("printf '%s' \"$1\" > {}", log.display()),
    );
    assert_eq!(
        code(&repo.run(&[
            "open",
            "Private/notes.md",
            "--editor",
            &editor.to_string_lossy()
        ])),
        0
    );

    let path = std::fs::read_to_string(&log).expect("read");
    assert!(path.ends_with(".md"), "the editor was handed {path}");
    // And it was outside the repository.
    assert!(
        !path.contains("/repo/"),
        "the decrypted file was inside the repository: {path}"
    );
}

#[test]
fn commit_records_the_edit() {
    let repo = repo_with_document("original\n");
    let editor = editor_script(&repo, "append", "printf 'edited\\n' >> \"$1\"");

    let output = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &editor.to_string_lossy(),
        "--commit",
    ]);
    assert_eq!(code(&output), 0, "{}", err(&output));

    let log = Command::new("git")
        .current_dir(&repo.root)
        .args(["log", "--oneline"])
        .output()
        .expect("git log");
    let log = String::from_utf8_lossy(&log.stdout);
    assert_eq!(log.lines().count(), 2, "expected two commits:\n{log}");
    assert!(log.contains("Edit Private/notes.md.age"), "{log}");
}

// --- Refusals ------------------------------------------------------------

#[test]
fn a_session_that_could_not_be_saved_is_not_started() {
    // No recipients means no way to re-encrypt, so the document is never
    // decrypted in the first place.
    let repo = repo_with_document("original\n");
    let recipients = repo.root.join("Private/recipients.txt");
    std::fs::write(&recipients, "# none\n").expect("write");

    let editor = editor_script(&repo, "noop", "exit 0");
    let output = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("no recipients"), "{}", err(&output));
    assert!(
        repo.scratch_files().is_empty(),
        "the document was decrypted anyway"
    );
    assert!(repo.locks().is_empty());
}

#[test]
fn a_plaintext_file_in_an_encrypted_vault_points_at_encrypt() {
    let repo = repo_with_document("original\n");
    let stray = repo.root.join("Private/stray.md");
    std::fs::write(&stray, "in the clear\n").expect("write");

    let editor = editor_script(&repo, "noop", "exit 0");
    let output = repo.run(&[
        "open",
        "Private/stray.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("fjord encrypt"), "{}", err(&output));
}

#[test]
fn a_plaintext_vault_needs_no_decryption() {
    let repo = repo_with_document("original\n");
    let editor = editor_script(&repo, "append", "printf 'more\\n' >> \"$1\"");

    let output = repo.run(&[
        "open",
        "Public/welcome.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 0, "{}", err(&output));
    assert!(out(&output).contains("saved"), "{}", out(&output));
    assert!(std::fs::read_to_string(repo.root.join("Public/welcome.md"))
        .expect("read")
        .ends_with("more\n"));
    // Edited in place, so nothing was written to the scratch directory.
    assert!(repo.scratch_files().is_empty());
}

#[test]
fn no_editor_is_a_usage_error_not_a_guess() {
    let repo = repo_with_document("original\n");
    let output = repo.run(&["open", "Private/notes.md"]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("EDITOR"), "{}", err(&output));
}

#[test]
fn a_newer_repository_is_never_written_to() {
    // Invariant 4 and §10.1.
    let repo = repo_with_document("original\n");
    let manifest = repo.root.join("fjord.json");
    let contents = std::fs::read_to_string(&manifest).expect("read");
    std::fs::write(&manifest, contents.replace("\"fjord\": 1", "\"fjord\": 2")).expect("write");

    let editor = editor_script(&repo, "append", "printf 'edited\\n' >> \"$1\"");
    let before = std::fs::read(repo.payload()).expect("read");

    let output = repo.run(&[
        "open",
        "Private/notes.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("version 2"), "{}", err(&output));
    assert_eq!(std::fs::read(repo.payload()).expect("read"), before);
    assert!(repo.scratch_files().is_empty());
}

#[test]
fn a_missing_document_is_refused() {
    let repo = repo_with_document("original\n");
    let editor = editor_script(&repo, "noop", "exit 0");
    let output = repo.run(&[
        "open",
        "Private/nothing.md",
        "--editor",
        &editor.to_string_lossy(),
    ]);
    assert_eq!(code(&output), 2);
    assert!(err(&output).contains("does not exist"), "{}", err(&output));
}

/// Keep `Path` referenced for the helpers above.
#[allow(dead_code)]
fn _path(_: &Path) {}

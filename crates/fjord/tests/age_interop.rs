//! Cross-validation against the reference `age` implementation.
//!
//! **This is the most important test in the repository.** The format's
//! central promise is that `age -d` alone recovers a file — no Fjord, no
//! network, years from now. Fjord uses the Rust `age` crate rather than the
//! Go original, so that promise is a claim about two independent
//! implementations agreeing, and nothing but a test can establish it.
//!
//! Both directions are covered, at both layers:
//!
//! - `fjord` encrypts → the `age` binary decrypts.
//! - `age -R` encrypts → `fjord` decrypts.
//!
//! If the `age` binary is not installed these tests are skipped rather than
//! failed, because a missing tool is not a defect in this code. CI installs
//! it, so the skip never hides a regression there.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// Whether the reference implementation is available.
fn age_available() -> bool {
    Command::new("age")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn temp() -> tempfile::TempDir {
    match tempfile::tempdir() {
        Ok(temp) => temp,
        Err(err) => panic!("temporary directory: {err}"),
    }
}

fn fjord(arguments: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
    command
        .args(arguments)
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .env_remove("FJORD_IDENTITY");
    match command.output() {
        Ok(output) => output,
        Err(err) => panic!("could not run fjord: {err}"),
    }
}

fn code_of(output: &Output) -> i32 {
    match output.status.code() {
        Some(code) => code,
        None => panic!("killed by a signal"),
    }
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

/// A repository with an encrypted `Private` vault and one identity
/// registered, built entirely through the CLI — so the setup is itself
/// under test.
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    identity: PathBuf,
    recipient: String,
}

fn fixture() -> Fixture {
    let temp = temp();
    let root = temp.path().join("repo");
    let config = temp.path().join("config");

    let init = fjord(&["init", &root.to_string_lossy()]);
    assert_eq!(code_of(&init), 0, "init: {}", stderr_of(&init));

    // The identity lands outside the repository, which `key new` enforces.
    let identity = config.join("identity.txt");
    let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("FJORD_CONFIG_DIR", &config)
        .env("NO_COLOR", "1")
        .output()
        .expect("run fjord key new");
    assert_eq!(
        output.status.code(),
        Some(0),
        "key new: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).expect("key new --json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();
    assert!(identity.is_file(), "no identity was written");

    let add = fjord(&[
        "-C",
        &root.to_string_lossy(),
        "key",
        "add",
        &recipient,
        "--vault",
        "Private",
    ]);
    assert_eq!(code_of(&add), 0, "key add: {}", stderr_of(&add));

    Fixture {
        _temp: temp,
        root,
        identity,
        recipient,
    }
}

fn age(arguments: &[&str], stdin: Option<&[u8]>) -> Output {
    let mut command = Command::new("age");
    command
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().expect("spawn age");
    if let Some(bytes) = stdin {
        child
            .stdin
            .as_mut()
            .expect("age stdin")
            .write_all(bytes)
            .expect("write to age");
    }
    child.wait_with_output().expect("age output")
}

// --- fjord encrypts, age decrypts ----------------------------------------

#[test]
fn the_age_binary_decrypts_what_fjord_wrote() {
    if !age_available() {
        eprintln!("skipping: the `age` binary is not installed");
        return;
    }
    let fixture = fixture();

    // Non-ASCII and a trailing newline, because an encoding slip would
    // otherwise pass.
    let plaintext = "# Groceries\n\nmilk — oats\nolives\n";
    let source = fixture.root.join("Private/groceries.md");
    std::fs::write(&source, plaintext).expect("write plaintext");

    let encrypt = fjord(&[
        "-C",
        &fixture.root.to_string_lossy(),
        "encrypt",
        &source.to_string_lossy(),
    ]);
    assert_eq!(code_of(&encrypt), 0, "encrypt: {}", stderr_of(&encrypt));

    let payload = fixture.root.join("Private/groceries.md.age");
    assert!(payload.is_file(), "no payload was written");
    assert!(!source.exists(), "the plaintext was not removed");

    // The whole promise of the format, in one command.
    let output = age(
        &[
            "-d",
            "-i",
            &fixture.identity.to_string_lossy(),
            &payload.to_string_lossy(),
        ],
        None,
    );
    assert!(
        output.status.success(),
        "`age -d` failed on a payload fjord wrote: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), plaintext);
}

#[test]
fn the_age_binary_decrypts_a_binary_payload_byte_for_byte() {
    if !age_available() {
        eprintln!("skipping: the `age` binary is not installed");
        return;
    }
    let fixture = fixture();

    // Every byte value, so a text-mode or UTF-8 assumption anywhere would
    // show up.
    let plaintext: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
    let source = fixture.root.join("Private/scan.bin");
    std::fs::write(&source, &plaintext).expect("write plaintext");

    let encrypt = fjord(&[
        "-C",
        &fixture.root.to_string_lossy(),
        "encrypt",
        &source.to_string_lossy(),
    ]);
    assert_eq!(code_of(&encrypt), 0, "encrypt: {}", stderr_of(&encrypt));

    let output = age(
        &[
            "-d",
            "-i",
            &fixture.identity.to_string_lossy(),
            &fixture.root.join("Private/scan.bin.age").to_string_lossy(),
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout, plaintext,
        "bytes did not survive the round trip"
    );
}

// --- age encrypts, fjord decrypts ----------------------------------------

#[test]
fn fjord_decrypts_what_the_age_binary_wrote() {
    if !age_available() {
        eprintln!("skipping: the `age` binary is not installed");
        return;
    }
    let fixture = fixture();

    let plaintext = "written by age itself — not by fjord\n";
    let payload = fixture.root.join("Private/external.md.age");

    // Exactly the command the generated README tells a user to run.
    let output = age(
        &[
            "-R",
            &fixture
                .root
                .join("Private/recipients.txt")
                .to_string_lossy(),
            "-o",
            &payload.to_string_lossy(),
        ],
        Some(plaintext.as_bytes()),
    );
    assert!(
        output.status.success(),
        "`age -R recipients.txt` failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let decrypt = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args([
            "-C",
            &fixture.root.to_string_lossy(),
            "--identity",
            &fixture.identity.to_string_lossy(),
            "decrypt",
            &payload.to_string_lossy(),
        ])
        .env("NO_COLOR", "1")
        .output()
        .expect("run fjord decrypt");
    assert_eq!(
        decrypt.status.code(),
        Some(0),
        "decrypt: {}",
        String::from_utf8_lossy(&decrypt.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&decrypt.stdout), plaintext);
}

#[test]
fn fjord_decrypts_an_armored_payload_from_the_age_binary() {
    if !age_available() {
        eprintln!("skipping: the `age` binary is not installed");
        return;
    }
    let fixture = fixture();

    let plaintext = "armored by age\n";
    let payload = fixture.root.join("Private/armored.md.age");
    let output = age(
        &[
            "-a",
            "-r",
            &fixture.recipient,
            "-o",
            &payload.to_string_lossy(),
        ],
        Some(plaintext.as_bytes()),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let contents = std::fs::read_to_string(&payload).expect("read");
    assert!(contents.starts_with("-----BEGIN AGE ENCRYPTED FILE-----"));

    // The vault's manifest says `armor: false`, yet an armored payload must
    // still read: a reader detects the armor from the file, not the
    // manifest.
    let decrypt = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args([
            "-C",
            &fixture.root.to_string_lossy(),
            "--identity",
            &fixture.identity.to_string_lossy(),
            "decrypt",
            &payload.to_string_lossy(),
        ])
        .env("NO_COLOR", "1")
        .output()
        .expect("run fjord decrypt");
    assert_eq!(
        decrypt.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&decrypt.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&decrypt.stdout), plaintext);
}

/// The recovery procedure the generated README documents, run verbatim
/// against a vault Fjord wrote. If this breaks, the README is lying.
#[test]
fn the_documented_recovery_procedure_works() {
    if !age_available() {
        eprintln!("skipping: the `age` binary is not installed");
        return;
    }
    let fixture = fixture();

    let documents = [
        ("Private/one.md", "first\n"),
        ("Private/Inbox/two.md", "second\n"),
    ];
    for (relative, contents) in documents {
        let path = fixture.root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create");
        }
        std::fs::write(&path, contents).expect("write");
        let encrypt = fjord(&[
            "-C",
            &fixture.root.to_string_lossy(),
            "encrypt",
            &path.to_string_lossy(),
        ]);
        assert_eq!(code_of(&encrypt), 0, "{}", stderr_of(&encrypt));
    }

    // Two standard tools, no Fjord.
    for (relative, expected) in documents {
        let payload = fixture.root.join(format!("{relative}.age"));
        let output = age(
            &[
                "-d",
                "-i",
                &fixture.identity.to_string_lossy(),
                &payload.to_string_lossy(),
            ],
            None,
        );
        assert!(
            output.status.success(),
            "recovery failed for {relative}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
    }
}

/// `age-keygen` keys must work in Fjord, and Fjord's keys in `age`. A user
/// who followed the README before installing Fjord has `age-keygen` keys.
#[test]
fn keys_from_age_keygen_are_interchangeable() {
    if !age_available() {
        eprintln!("skipping: the `age` binary is not installed");
        return;
    }
    let temp = temp();
    let identity = temp.path().join("from-age-keygen.txt");

    let generated = Command::new("age-keygen")
        .arg("-o")
        .arg(&identity)
        .output()
        .expect("run age-keygen");
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );

    let public = Command::new("age-keygen")
        .arg("-y")
        .arg(&identity)
        .output()
        .expect("run age-keygen -y");
    let recipient = String::from_utf8_lossy(&public.stdout).trim().to_string();

    let root = temp.path().join("repo");
    let init = fjord(&["init", &root.to_string_lossy()]);
    assert_eq!(code_of(&init), 0, "{}", stderr_of(&init));

    let add = fjord(&[
        "-C",
        &root.to_string_lossy(),
        "key",
        "add",
        &recipient,
        "--vault",
        "Private",
    ]);
    assert_eq!(code_of(&add), 0, "key add: {}", stderr_of(&add));

    let source = root.join("Private/notes.md");
    std::fs::write(&source, "interchangeable\n").expect("write");
    let encrypt = fjord(&[
        "-C",
        &root.to_string_lossy(),
        "encrypt",
        &source.to_string_lossy(),
    ]);
    assert_eq!(code_of(&encrypt), 0, "{}", stderr_of(&encrypt));

    let output = age(
        &[
            "-d",
            "-i",
            &identity.to_string_lossy(),
            &root.join("Private/notes.md.age").to_string_lossy(),
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "interchangeable\n");
}

/// Guard against the skip silently becoming permanent.
#[test]
fn the_reference_implementation_is_available_here() {
    if std::env::var_os("CI").is_some() {
        assert!(
            age_available(),
            "CI must have the `age` binary installed: cross-validation is the test \
             that backs the format's recovery promise"
        );
    } else if !age_available() {
        eprintln!("note: the `age` binary is not installed, so cross-validation was skipped");
    }
}

/// Keep `Path` referenced for the helper signatures above.
#[allow(dead_code)]
fn _path(_: &Path) {}

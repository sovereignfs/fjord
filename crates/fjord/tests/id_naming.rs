//! `fileNaming: "id"` and the tar container. Spec §6.4, §7.2.
//!
//! M7's acceptance criteria are three, and the first three tests are
//! exactly them: a vault in id mode round-trips a file whose name contains
//! a space, `age -d | tar -x` recovers the original name, and §6.4's
//! malformed-archive rejections are all tested (in
//! `fjord_core::container`, where they can be driven directly).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}

impl Repo {
    fn run(&self, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("TMPDIR", self.temp.path())
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .env_remove("EDITOR");
        command.output().expect("run fjord")
    }

    fn identity(&self) -> PathBuf {
        self.config.join("identity.txt")
    }

    /// The single payload in the `Secret` vault.
    fn payload(&self) -> PathBuf {
        let directory = self.root.join("Secret");
        let mut found: Vec<PathBuf> = std::fs::read_dir(&directory)
            .expect("read Secret")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map(|e| e == "age").unwrap_or(false))
            .collect();
        found.sort();
        assert_eq!(found.len(), 1, "expected one payload, found {found:?}");
        found.remove(0)
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

/// A repository with an id-naming, tar-container vault called `Secret`.
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
    assert_eq!(init.status.code(), Some(0), "{}", err(&init));

    let generated = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &repo.config)
        .current_dir(repo.temp.path())
        .output()
        .expect("key new");
    assert_eq!(generated.status.code(), Some(0), "{}", err(&generated));
    let report: serde_json::Value = serde_json::from_slice(&generated.stdout).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();

    let created = repo.run(&["vault", "add", "Secret", "--encrypted", "--id-naming"]);
    assert_eq!(code(&created), 0, "vault add: {}", err(&created));

    let added = repo.run(&["key", "add", &recipient, "--vault", "Secret"]);
    assert_eq!(code(&added), 0, "key add: {}", err(&added));

    // A vault created this way must itself conform.
    let verified = repo.run(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", out(&verified));

    repo
}

// --- The acceptance criteria ---------------------------------------------

/// "A vault in id mode round-trips a file whose name contains a space."
#[test]
fn a_name_with_a_space_round_trips_in_id_mode() {
    let repo = repo();
    let name = "my sync design.md";

    let created = repo.run(&["new", &format!("Secret/{name}"), "--no-edit"]);
    assert_eq!(code(&created), 0, "{}", err(&created));

    // §7.2: the leaf on disk is the ULID, so the real name is nowhere in
    // the filesystem.
    let payload = repo.payload();
    let leaf = payload
        .file_name()
        .expect("leaf")
        .to_string_lossy()
        .to_string();
    let stem = leaf.strip_suffix(".age").expect("a .age payload");
    assert_eq!(stem.len(), 26, "the leaf should be a ULID, got {leaf:?}");
    assert!(!leaf.contains(' '), "the name leaked onto disk: {leaf}");
    assert!(!leaf.contains("sync"), "the name leaked onto disk: {leaf}");

    // And it comes back out of the container intact.
    let decrypted = repo.run(&["decrypt", &format!("Secret/{leaf}")]);
    assert_eq!(code(&decrypted), 0, "{}", err(&decrypted));
    assert!(
        out(&decrypted).contains("title: my sync design"),
        "{}",
        out(&decrypted)
    );

    // The document's id is the name it is stored under.
    assert!(
        out(&decrypted).contains(&format!("id: {stem}")),
        "the file name should be the document's id: {}",
        out(&decrypted)
    );

    let verified = repo.run(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", out(&verified));
}

/// "`age -d | tar -x` recovers the original name."
///
/// The recovery promise, for the one mode where the name is not on disk.
#[test]
fn age_and_tar_recover_the_original_name() {
    if !tools_available() {
        eprintln!("skipping: `age` or `tar` is not installed");
        return;
    }
    let repo = repo();
    let name = "quarterly report.md";
    assert_eq!(
        code(&repo.run(&["new", &format!("Secret/{name}"), "--no-edit"])),
        0
    );

    let payload = repo.payload();
    let restored = repo.temp.path().join("restored");
    std::fs::create_dir_all(&restored).expect("create");

    // Exactly the documented procedure: two standard tools, no Fjord.
    let decrypted = Command::new("age")
        .args(["-d", "-i"])
        .arg(repo.identity())
        .arg(&payload)
        .output()
        .expect("run age");
    assert!(
        decrypted.status.success(),
        "age failed: {}",
        String::from_utf8_lossy(&decrypted.stderr)
    );

    let mut tar = Command::new("tar")
        .args(["-xf", "-", "-C"])
        .arg(&restored)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("spawn tar");
    {
        use std::io::Write;
        tar.stdin
            .as_mut()
            .expect("tar stdin")
            .write_all(&decrypted.stdout)
            .expect("write to tar");
    }
    assert!(tar.wait().expect("wait for tar").success(), "tar failed");

    // The file is there, under the name it was created with.
    let recovered = restored.join(name);
    assert!(
        recovered.is_file(),
        "`age -d | tar -x` did not produce {name:?}; found {:?}",
        std::fs::read_dir(&restored)
            .expect("read")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .collect::<Vec<_>>()
    );
    let contents = std::fs::read_to_string(&recovered).expect("read");
    assert!(contents.contains("title: quarterly report"), "{contents}");
}

/// The GNU/BSD `tar` must also accept what we write for a *binary*
/// document, which is the case the container exists for: a PDF cannot carry
/// frontmatter, so the container is the only place its name can live.
#[test]
fn a_binary_document_recovers_its_name_and_bytes() {
    if !tools_available() {
        eprintln!("skipping: `age` or `tar` is not installed");
        return;
    }
    let repo = repo();
    let name = "scan of the deed.bin";
    let bytes: Vec<u8> = (0..=255u8).cycle().take(4096).collect();

    let source = repo.root.join("Secret").join(name);
    std::fs::write(&source, &bytes).expect("write");
    let encrypted = repo.run(&["encrypt", &format!("Secret/{name}")]);
    assert_eq!(code(&encrypted), 0, "{}", err(&encrypted));
    assert!(!source.exists(), "the plaintext survived");

    let payload = repo.payload();
    let restored = repo.temp.path().join("restored");
    std::fs::create_dir_all(&restored).expect("create");

    let decrypted = Command::new("age")
        .args(["-d", "-i"])
        .arg(repo.identity())
        .arg(&payload)
        .output()
        .expect("run age");
    assert!(decrypted.status.success());

    let mut tar = Command::new("tar")
        .args(["-xf", "-", "-C"])
        .arg(&restored)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("spawn tar");
    {
        use std::io::Write;
        tar.stdin
            .as_mut()
            .expect("stdin")
            .write_all(&decrypted.stdout)
            .expect("write");
    }
    assert!(tar.wait().expect("wait").success());

    assert_eq!(
        std::fs::read(restored.join(name)).expect("read"),
        bytes,
        "the bytes did not survive the container"
    );
}

fn tools_available() -> bool {
    ["age", "tar"].iter().all(|tool| {
        Command::new(tool)
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    })
}

// --- The rules §7.2 imposes ----------------------------------------------

#[test]
fn id_naming_requires_encryption() {
    // §7.2: identifier names on a plaintext vault conceal nothing and
    // destroy browsability, and clients MUST reject the combination.
    let repo = repo();
    let refused = repo.run(&["vault", "add", "Nope", "--id-naming"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("§7.2"), "{}", err(&refused));
    assert!(!repo.root.join("Nope").exists());
}

#[test]
fn an_id_vault_is_created_with_the_tar_container() {
    // §7.2: `container` MUST be "tar", and `fjord verify` reports E305 if
    // it is not — so creating the vault any other way would produce a
    // repository this tool calls non-conforming.
    let repo = repo();
    let listed = repo.run(&["vault", "list", "--json"]);
    let rows: serde_json::Value = serde_json::from_str(&out(&listed)).expect("json");
    let secret = rows
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["path"] == "Secret")
        .expect("Secret");

    assert_eq!(secret["fileNaming"], serde_json::Value::from("id"));
    assert_eq!(secret["container"], serde_json::Value::from("tar"));
    assert_eq!(secret["encrypted"], serde_json::Value::Bool(true));
}

#[test]
fn adding_a_vault_preserves_the_rest_of_the_manifest() {
    // Invariant 3 and §10.1: a field this build does not understand must
    // still be there afterwards.
    let repo = repo();
    let path = repo.root.join("fjord.json");
    let original = std::fs::read_to_string(&path).expect("read");
    let edited = original.replace(
        "\"vaults\":",
        "\"somethingFromANewerClient\": { \"b\": 2, \"a\": 1 },\n  \"vaults\":",
    );
    std::fs::write(&path, &edited).expect("write");

    assert_eq!(code(&repo.run(&["vault", "add", "Another"])), 0);

    let rewritten = std::fs::read_to_string(&path).expect("read");
    assert!(
        rewritten.contains("somethingFromANewerClient"),
        "an unknown field was dropped:\n{rewritten}"
    );
    // Order preserved too, which is what the parsed-map representation is
    // for.
    assert!(rewritten.contains("\"b\": 2"), "{rewritten}");
    let b = rewritten.find("\"b\"").expect("b");
    let a = rewritten.find("\"a\"").expect("a");
    assert!(b < a, "the unknown object's key order was not preserved");

    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn a_malformed_container_is_reported_when_the_document_is_read() {
    // E303. The archive is inside the ciphertext, so `fjord verify` never
    // sees it: this can only surface on the read path.
    let repo = repo();
    assert_eq!(code(&repo.run(&["new", "Secret/notes.md", "--no-edit"])), 0);
    let payload = repo.payload();

    // Replace the payload with an age file whose plaintext is not a tar
    // archive at all.
    let plain = repo.temp.path().join("not-a-tar");
    std::fs::write(&plain, "this is not a tar archive").expect("write");
    let recipients = repo.root.join("Secret/recipients.txt");
    let encrypted = Command::new("age")
        .args(["-R"])
        .arg(&recipients)
        .args(["-o"])
        .arg(&payload)
        .arg(&plain)
        .output()
        .expect("run age");
    if !encrypted.status.success() {
        eprintln!("skipping: `age` is not installed");
        return;
    }

    // `verify` is unaffected: it does not decrypt.
    assert_eq!(code(&repo.run(&["verify"])), 0);

    // Reading it reports the container problem rather than pretending.
    let read = repo.run(&[
        "decrypt",
        &format!(
            "Secret/{}",
            payload.file_name().expect("leaf").to_string_lossy()
        ),
    ]);
    assert_ne!(code(&read), 0, "a malformed container was accepted");
    let message = err(&read);
    assert!(
        message.contains("tar") || message.contains("container"),
        "{message}"
    );
}

#[test]
fn grep_and_ls_read_through_the_container() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&[
            "new",
            "Secret/budget.md",
            "--title",
            "The Budget",
            "--no-edit"
        ])),
        0
    );

    // `ls --long` reads frontmatter from inside the container.
    let listed = repo.run(&["ls", "Secret", "--long"]);
    assert_eq!(code(&listed), 0, "{}", err(&listed));
    assert!(out(&listed).contains("The Budget"), "{}", out(&listed));

    // `grep` searches through it.
    let found = repo.run(&["grep", "The Budget"]);
    assert_eq!(code(&found), 0, "{}", err(&found));
    assert!(out(&found).contains("The Budget"), "{}", out(&found));
}

/// Keep `Path` referenced for the helpers above.
#[allow(dead_code)]
fn _path(_: &Path) {}

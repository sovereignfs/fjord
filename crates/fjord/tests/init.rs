// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end tests for `fjord init`.
//!
//! M2's acceptance criterion is one line — `fjord init x && cd x && fjord
//! verify` exits 0 — and `the_acceptance_criterion` is exactly that. The
//! rest guard the things a scaffolder gets wrong: writing over someone's
//! files, producing a repository git will not commit, and drifting away
//! from the fixture that defines what conforming looks like.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

/// Run the binary, with a git identity supplied through the environment so
/// the commit works on a machine — or a CI runner — with no global config.
fn fjord(arguments: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
    command
        .args(arguments)
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        // An identity in the ambient environment must not change what a
        // test does.
        .env_remove("FJORD_IDENTITY");
    match command.output() {
        Ok(output) => output,
        Err(err) => panic!("could not run the fjord binary: {err}"),
    }
}

fn code_of(output: &Output) -> i32 {
    match output.status.code() {
        Some(code) => code,
        None => panic!("fjord was killed by a signal"),
    }
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn temp() -> tempfile::TempDir {
    match tempfile::tempdir() {
        Ok(temp) => temp,
        Err(err) => panic!("temporary directory: {err}"),
    }
}

/// Every file in a directory, repository-relative, sorted, `.git` excluded.
fn files_in(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    collect(root, root, &mut found);
    found.sort();
    found
}

fn collect(root: &Path, directory: &Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(err) => panic!("read {}: {err}", directory.display()),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => panic!("{err}"),
        };
        let path = entry.path();
        if entry.file_name() == ".git" {
            continue;
        }
        if path.is_dir() {
            collect(root, &path, out);
        } else {
            let relative = match path.strip_prefix(root) {
                Ok(relative) => relative,
                Err(err) => panic!("{err}"),
            };
            out.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
}

// --- The acceptance criterion --------------------------------------------

#[test]
fn the_acceptance_criterion() {
    // `fjord init x && cd x && fjord verify` exits 0.
    let temp = temp();
    let target = temp.path().join("x");

    let init = fjord(&["init", &target.to_string_lossy()]);
    assert_eq!(
        code_of(&init),
        0,
        "init failed: {}{}",
        stdout_of(&init),
        stderr_of(&init)
    );

    let verify = fjord(&["-C", &target.to_string_lossy(), "verify"]);
    assert_eq!(
        code_of(&verify),
        0,
        "verify failed on a freshly created repository: {}",
        stdout_of(&verify)
    );
}

#[test]
fn a_fresh_repository_warns_only_that_private_has_no_keys() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    let verify = fjord(&["-C", &target.to_string_lossy(), "verify", "--json"]);
    let report: Value = match serde_json::from_str(&stdout_of(&verify)) {
        Ok(report) => report,
        Err(err) => panic!("{err}: {}", stdout_of(&verify)),
    };

    assert_eq!(report["counts"]["errors"], Value::from(0));
    assert_eq!(report["counts"]["warnings"], Value::from(1));
    assert_eq!(report["conforms"], Value::Bool(true));

    let diagnostics = report["diagnostics"].as_array().expect("diagnostics");
    assert_eq!(diagnostics.len(), 1);
    // W602: valid, and deliberately unwritable until a key is added.
    assert_eq!(diagnostics[0]["code"], Value::from("W602"));

    // And --strict makes that warning fail, as it should.
    let strict = fjord(&["-C", &target.to_string_lossy(), "verify", "--strict"]);
    assert_eq!(code_of(&strict), 1);
}

#[test]
fn a_plaintext_repository_is_completely_clean() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(
        code_of(&fjord(&["init", &target.to_string_lossy(), "--no-encrypt"])),
        0
    );

    let verify = fjord(&["-C", &target.to_string_lossy(), "verify", "--json"]);
    let report: Value = serde_json::from_str(&stdout_of(&verify)).expect("JSON");
    assert_eq!(report["counts"]["errors"], Value::from(0));
    assert_eq!(
        report["counts"]["warnings"],
        Value::from(0),
        "a plaintext repository should have nothing to warn about: {}",
        stdout_of(&verify)
    );

    assert!(!target.join("Private/recipients.txt").exists());
    assert!(!target.join("Private/.gitignore").exists());
}

// --- Agreement with the fixture ------------------------------------------

#[test]
fn init_produces_what_the_conforming_fixture_describes() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    assert_eq!(
        files_in(&target),
        files_in(&fixtures().join("conforming")),
        "init and the conforming fixture disagree about what a repository contains"
    );
}

#[test]
fn the_static_files_are_byte_identical_to_the_fixture() {
    // These are generated from the same templates the fixture was built
    // from. If they drift, one of the two is lying about the format.
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    let conforming = fixtures().join("conforming");
    for relative in [
        ".gitattributes",
        ".gitignore",
        "README.md",
        "Private/.gitignore",
    ] {
        let generated = std::fs::read_to_string(target.join(relative)).expect(relative);
        let fixture = std::fs::read_to_string(conforming.join(relative)).expect(relative);
        assert_eq!(
            generated, fixture,
            "{relative} has drifted from the fixture"
        );
    }

    // recipients.txt is the one exception: the fixture carries a placeholder
    // key so that it emits no W602, while a fresh one deliberately has none.
    // The instructions must still match.
    let generated = std::fs::read_to_string(target.join("Private/recipients.txt")).expect("read");
    let fixture = std::fs::read_to_string(conforming.join("Private/recipients.txt")).expect("read");
    assert!(
        fixture.starts_with(generated.trim_end()),
        "the recipients file instructions have drifted from the fixture"
    );
}

// --- Git -----------------------------------------------------------------

#[test]
fn git_is_initialised_with_one_commit_on_main() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    assert!(
        target.join(".git").is_dir(),
        "no git repository was created"
    );

    let branch = git(&target, &["rev-parse", "--abbrev-ref", "HEAD"]);
    assert_eq!(branch, "main");

    let count = git(&target, &["rev-list", "--count", "HEAD"]);
    assert_eq!(count, "1", "expected exactly one commit");

    // Every file written is tracked — including the ones inside the
    // encrypted vault, whose §6.5 guard ignores everything by default.
    let mut tracked: Vec<String> = git(&target, &["ls-files"])
        .lines()
        .map(|line| line.to_string())
        .collect();
    tracked.sort();
    assert_eq!(
        tracked,
        files_in(&target),
        "the first commit does not contain every file init wrote"
    );
}

#[test]
fn no_git_skips_the_repository_entirely() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(
        code_of(&fjord(&["init", &target.to_string_lossy(), "--no-git"])),
        0
    );
    assert!(!target.join(".git").exists());
    // The repository is still conforming without git.
    assert_eq!(
        code_of(&fjord(&["-C", &target.to_string_lossy(), "verify"])),
        0
    );
}

#[test]
fn an_existing_empty_git_repository_is_reused() {
    let temp = temp();
    let target = temp.path().join("x");
    std::fs::create_dir_all(&target).expect("create");
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(&target)
        .status()
        .expect("git init")
        .success());

    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);
    // Reused, not nested.
    assert_eq!(git(&target, &["rev-list", "--count", "HEAD"]), "1");
    assert!(!target.join(".git/.git").exists());
}

fn git(root: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(arguments)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

// --- Refusals ------------------------------------------------------------

#[test]
fn a_non_empty_directory_is_never_written_over() {
    let temp = temp();
    let target = temp.path().join("x");
    std::fs::create_dir_all(&target).expect("create");
    std::fs::write(target.join("notes.md"), "my work").expect("write");

    let output = fjord(&["init", &target.to_string_lossy()]);
    assert_eq!(code_of(&output), 2, "expected a usage error");
    assert!(
        stderr_of(&output).contains("not empty"),
        "{}",
        stderr_of(&output)
    );

    // Untouched.
    assert_eq!(
        std::fs::read_to_string(target.join("notes.md")).expect("read"),
        "my work"
    );
    assert_eq!(files_in(&target), vec!["notes.md".to_string()]);
}

#[test]
fn an_existing_repository_is_not_scaffolded_twice() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    let again = fjord(&["init", &target.to_string_lossy()]);
    assert_eq!(code_of(&again), 2);
    assert!(stderr_of(&again).contains("not empty"));
}

#[test]
fn identity_is_refused_until_key_add_exists() {
    // Accepting it silently would produce a repository the user believes
    // they can write to.
    let temp = temp();
    let target = temp.path().join("x");
    let output = fjord(&[
        "init",
        &target.to_string_lossy(),
        "--identity",
        "/nonexistent/identity.txt",
    ]);
    assert_eq!(code_of(&output), 2);
    assert!(
        stderr_of(&output).contains("key add"),
        "{}",
        stderr_of(&output)
    );
    assert!(!target.exists(), "nothing should have been written");
}

// --- Options -------------------------------------------------------------

#[test]
fn the_name_defaults_to_the_directory_and_can_be_overridden() {
    let temp = temp();

    let defaulted = temp.path().join("my-documents");
    assert_eq!(code_of(&fjord(&["init", &defaulted.to_string_lossy()])), 0);
    let manifest = std::fs::read_to_string(defaulted.join("fjord.json")).expect("read");
    assert!(
        manifest.contains("\"name\": \"my-documents\""),
        "{manifest}"
    );

    let named = temp.path().join("other");
    assert_eq!(
        code_of(&fjord(&[
            "init",
            &named.to_string_lossy(),
            "--name",
            "Research notes"
        ])),
        0
    );
    let manifest = std::fs::read_to_string(named.join("fjord.json")).expect("read");
    assert!(
        manifest.contains("\"name\": \"Research notes\""),
        "{manifest}"
    );
}

#[test]
fn json_output_describes_what_was_created() {
    let temp = temp();
    let target = temp.path().join("x");
    let output = fjord(&["init", &target.to_string_lossy(), "--json"]);
    assert_eq!(code_of(&output), 0);

    let document: Value = match serde_json::from_str(&stdout_of(&output)) {
        Ok(document) => document,
        Err(err) => panic!("{err}: {}", stdout_of(&output)),
    };
    assert_eq!(document["name"], Value::from("x"));
    assert_eq!(document["git"]["initialised"], Value::Bool(true));
    assert_eq!(document["git"]["branch"], Value::from("main"));

    let vaults = document["vaults"].as_array().expect("vaults");
    assert_eq!(vaults.len(), 2);
    assert_eq!(vaults[0]["path"], Value::from("Public"));
    assert_eq!(vaults[0]["encrypted"], Value::Bool(false));
    assert_eq!(vaults[1]["path"], Value::from("Private"));
    assert_eq!(vaults[1]["encrypted"], Value::Bool(true));

    let files = document["files"].as_array().expect("files");
    assert_eq!(files.len(), 9);

    // The repository id is a ULID, and it is the one in the manifest.
    let id = document["repositoryId"].as_str().expect("repositoryId");
    assert_eq!(id.len(), 26);
    assert!(std::fs::read_to_string(target.join("fjord.json"))
        .expect("read")
        .contains(id));
}

#[test]
fn quiet_prints_nothing_on_success() {
    let temp = temp();
    let target = temp.path().join("x");
    let output = fjord(&["init", &target.to_string_lossy(), "--quiet"]);
    assert_eq!(code_of(&output), 0);
    assert_eq!(stdout_of(&output), "");
}

#[test]
fn no_input_never_prompts() {
    // Non-interactive by construction here — stdin is not a terminal — but
    // --no-input must also hold when one is attached, and it must not hang.
    let temp = temp();
    let target = temp.path().join("x");
    let output = fjord(&["init", &target.to_string_lossy(), "--no-input"]);
    assert_eq!(code_of(&output), 0);
    assert!(!stderr_of(&output).contains("Repository name"));
}

// --- Identifiers ------------------------------------------------------------

/// Every maximal run of 26 ASCII alphanumerics starting with `0`–`7`, which
/// is what an identifier looks like in any text file.
fn identifier_like_tokens(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut current = String::new();
    for character in text.chars().chain(std::iter::once(' ')) {
        if character.is_ascii_alphanumeric() {
            current.push(character);
            continue;
        }
        let first = current.chars().next();
        if current.len() == 26 && matches!(first, Some('0'..='7')) {
            found.push(current.clone());
        }
        current.clear();
    }
    found
}

/// Spec §8.3 requires lowercase, and §7.2 makes the id a file name in `id`
/// vaults. Every path that mints an identifier — `init`, `vault add` and
/// `new` — has to agree, so this drives all three and then looks at every
/// file written, rather than trusting each call site.
#[test]
fn every_identifier_fjord_writes_is_lowercase() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    for arguments in [
        vec!["-C", &*target.to_string_lossy(), "vault", "add", "Extra"],
        vec![
            "-C",
            &*target.to_string_lossy(),
            "new",
            "Public/a.md",
            "--no-edit",
        ],
    ] {
        let output = fjord(&arguments);
        assert_eq!(code_of(&output), 0, "{}", stderr_of(&output));
    }

    let mut all = Vec::new();
    for relative in files_in(&target) {
        let Ok(text) = std::fs::read_to_string(target.join(&relative)) else {
            continue;
        };
        for token in identifier_like_tokens(&text) {
            all.push((relative.clone(), token));
        }
    }

    // fjord.json (1 + 3 vaults), three vault manifests, and two documents:
    // far more than a handful, so this cannot pass by finding nothing.
    assert!(
        all.len() >= 8,
        "expected to find identifiers, found {all:?}"
    );
    for (file, token) in &all {
        assert_eq!(
            token,
            &token.to_ascii_lowercase(),
            "{file} contains an identifier that is not lowercase: {token}"
        );
    }

    // And the repository the CLI just wrote conforms by its own checker.
    let verify = fjord(&["-C", &target.to_string_lossy(), "verify"]);
    assert_eq!(code_of(&verify), 0, "{}", stdout_of(&verify));
}

// --- The generator field ----------------------------------------------------

fn manifest_of(root: &Path) -> Value {
    let text = match std::fs::read_to_string(root.join("fjord.json")) {
        Ok(text) => text,
        Err(err) => panic!("read fjord.json: {err}"),
    };
    match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => panic!("fjord.json is not JSON: {err}"),
    }
}

/// `generator` must name the version that actually ran — so it is compared
/// with what the binary says about itself, not with a literal that would
/// keep passing after a version bump left it behind.
#[test]
fn init_records_the_generator_as_the_binary_reports_itself() {
    let version = fjord(&["--version"]);
    assert_eq!(code_of(&version), 0);
    let reported = stdout_of(&version).trim().to_string();
    // `fjord <version>`: the binary's name, not `fjord-init`, which is a
    // subcommand and was only ever in the spec's example.
    assert!(reported.starts_with("fjord "), "{reported}");

    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    let manifest = manifest_of(&target);
    assert_eq!(
        manifest["generator"],
        Value::from(reported.as_str()),
        "generator disagrees with `fjord --version`"
    );
    // And with the version this build was compiled as.
    assert_eq!(
        manifest["generator"],
        Value::from(concat!("fjord ", env!("CARGO_PKG_VERSION")))
    );

    assert_eq!(
        code_of(&fjord(&["-C", &target.to_string_lossy(), "verify"])),
        0
    );
}

/// `vault add` rewrites fjord.json through the parsed map. What `init`
/// recorded is not that command's to change (invariant 3), and in
/// particular a later, newer build must not quietly claim to have made a
/// repository it only added a vault to.
#[test]
fn later_commands_leave_the_generator_alone() {
    let temp = temp();
    let target = temp.path().join("x");
    assert_eq!(code_of(&fjord(&["init", &target.to_string_lossy()])), 0);

    // Pretend a different tool created it, then let this one write to it.
    let path = target.join("fjord.json");
    let text = std::fs::read_to_string(&path).expect("read");
    std::fs::write(
        &path,
        text.replace("\"generator\": \"fjord ", "\"generator\": \"fjord-desktop ")
            .replace("fjord-desktop 0.1.0", "fjord-desktop 9.9.9"),
    )
    .expect("write");

    let added = fjord(&["-C", &target.to_string_lossy(), "vault", "add", "Extra"]);
    assert_eq!(code_of(&added), 0, "{}", stderr_of(&added));

    assert_eq!(
        manifest_of(&target)["generator"],
        Value::from("fjord-desktop 9.9.9"),
        "vault add rewrote the generator"
    );
}

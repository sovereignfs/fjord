// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Repository kinds from the command line: `init --kind`, the kind in `verify`, and a journal's
//! `new`. Spec §3.1, §8.1. P11's acceptance is `fjord init --kind <k> x && cd x && fjord verify`
//! exiting 0 for each kind.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
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
        .env_remove("FJORD_IDENTITY")
        .env_remove("EDITOR")
        .env_remove("VISUAL");
    command.output().expect("run the fjord binary")
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

/// `init` with these arguments into a new directory, which is returned.
fn init(arguments: &[&str]) -> (tempfile::TempDir, String) {
    let temp = tempfile::tempdir().expect("temporary directory");
    let target = temp.path().join("x").to_string_lossy().to_string();
    let mut all = vec!["--no-input", "init", &target];
    all.extend_from_slice(arguments);
    let output = fjord(&all);
    assert_eq!(code(&output), 0, "init {arguments:?}: {}", text(&output));
    (temp, target)
}

fn verify(target: &str) -> Value {
    let output = fjord(&["-C", target, "verify", "--json"]);
    let report = json(&output);
    assert_eq!(code(&output), 0, "verify: {}", text(&output));
    report
}

fn codes(report: &Value) -> Vec<String> {
    report["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .map(|d| d["code"].as_str().expect("code").to_string())
        .collect()
}

#[test]
fn each_kind_is_made_and_verifies() {
    for (arguments, kind, warnings) in [
        (vec![], "drive", vec!["W602"]),
        (vec!["--kind", "drive", "--no-encrypt"], "drive", vec![]),
        // A journal is encrypted unless asked otherwise (RFC 0002), so it has no recipients yet.
        (vec!["--kind", "journal"], "journal", vec!["W602"]),
        (vec!["--kind", "journal", "--no-encrypt"], "journal", vec![]),
        (vec!["--kind", "ssg", "--engine", "astro"], "ssg", vec![]),
        (vec!["--kind", "ssg", "--engine", "jekyll"], "ssg", vec![]),
    ] {
        let (_temp, target) = init(&arguments);
        let report = verify(&target);
        assert_eq!(report["repositoryKind"], kind, "{arguments:?}");
        assert_eq!(codes(&report), warnings, "{arguments:?}");
        let vaults = report["vaults"].as_array().expect("vaults").len();
        assert_eq!(vaults, if kind == "drive" { 2 } else { 1 }, "{arguments:?}");
    }
}

#[test]
fn a_journal_is_encrypted_unless_no_encrypt_is_given() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let target = temp.path().join("x").to_string_lossy().to_string();
    let output = fjord(&[
        "--no-input",
        "--json",
        "init",
        &target,
        "--kind",
        "journal",
        "--no-encrypt",
        "--no-git",
    ]);
    assert_eq!(code(&output), 0, "{}", text(&output));
    assert_eq!(json(&output)["vaults"][0]["encrypted"], false);
}

#[test]
fn init_reports_the_kind_in_json() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let target = temp.path().join("x").to_string_lossy().to_string();
    let output = fjord(&[
        "--no-input",
        "--json",
        "init",
        &target,
        "--kind",
        "journal",
        "--no-git",
    ]);
    assert_eq!(code(&output), 0, "{}", text(&output));
    let made = json(&output);
    assert_eq!(made["kind"], "journal");
    assert_eq!(made["vaults"][0]["path"], "journal");
    assert_eq!(made["vaults"][0]["encrypted"], true);
}

#[test]
fn a_site_needs_an_engine_and_no_prompt_is_a_usage_error() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let target = temp.path().join("x").to_string_lossy().to_string();
    let output = fjord(&["--no-input", "init", &target, "--kind", "ssg"]);
    assert_eq!(code(&output), 2, "{}", text(&output));
    assert!(text(&output).contains("--engine"));
    assert!(!temp.path().join("x").exists(), "nothing is written");
}

#[test]
fn a_flag_for_another_kind_is_refused_rather_than_ignored() {
    for arguments in [
        vec!["--kind", "ssg", "--engine", "astro", "--no-encrypt"],
        vec!["--kind", "journal", "--engine", "astro"],
        vec!["--encrypt"],
    ] {
        let temp = tempfile::tempdir().expect("temporary directory");
        let target = temp.path().join("x").to_string_lossy().to_string();
        let mut all = vec!["--no-input", "init", target.as_str()];
        all.extend_from_slice(&arguments);
        let output = fjord(&all);
        assert_eq!(code(&output), 2, "{arguments:?}: {}", text(&output));
        assert!(
            !temp.path().join("x").exists(),
            "{arguments:?}: nothing is written"
        );
    }
}

#[test]
fn a_kind_s_broken_rule_fails_verify_with_its_code() {
    for fixture in ["E111", "E112"] {
        let root = fixtures().join("broken").join(fixture);
        let output = fjord(&["-C", &root.to_string_lossy(), "verify", "--json"]);
        assert_eq!(code(&output), 1, "{fixture}: {}", text(&output));
        assert_eq!(codes(&json(&output)), vec![fixture]);
    }
}

#[test]
fn verify_names_a_kind_that_is_not_a_drive() {
    let root = fixtures().join("journal");
    let output = fjord(&["-C", &root.to_string_lossy(), "verify"]);
    assert_eq!(code(&output), 0, "{}", text(&output));
    assert!(
        text(&output).contains("format version 1 · journal"),
        "{}",
        text(&output)
    );
}

/// A journal entry made with no path: dated, filed by its date, and verified.
#[test]
fn new_with_no_path_writes_a_journal_entry() {
    let (_temp, target) = init(&["--kind", "journal", "--no-encrypt"]);
    let output = fjord(&[
        "-C",
        &target,
        "new",
        "--no-edit",
        "--title",
        "Morning run",
        "--date",
        "2026-11-02T00:30:00+05:30",
    ]);
    assert_eq!(code(&output), 0, "{}", text(&output));
    let entry = Path::new(&target).join("journal/2026/11/02/0030-morning-run.md");
    let written = std::fs::read_to_string(&entry).expect("the entry, at the writer's day");
    assert!(
        written.contains("date: \"2026-11-02T00:30:00+05:30\""),
        "{written}"
    );
    assert!(written.contains("title: Morning run"), "{written}");

    // A second in the same minute is not refused: it takes a number.
    let again = fjord(&[
        "-C",
        &target,
        "new",
        "--no-edit",
        "--title",
        "Morning run",
        "--date",
        "2026-11-02T00:30:00+05:30",
    ]);
    assert_eq!(code(&again), 0, "{}", text(&again));
    assert!(Path::new(&target)
        .join("journal/2026/11/02/0030-morning-run-2.md")
        .is_file());

    // Dated now, with no title and no date given.
    let now = fjord(&["-C", &target, "new", "--no-edit"]);
    assert_eq!(code(&now), 0, "{}", text(&now));

    assert_eq!(codes(&verify(&target)), Vec::<String>::new());
}

#[test]
fn new_needs_a_path_outside_a_journal() {
    let (_temp, target) = init(&["--kind", "drive", "--no-encrypt"]);
    let output = fjord(&["-C", &target, "new", "--no-edit"]);
    assert_eq!(code(&output), 2, "{}", text(&output));
    assert!(
        text(&output).contains("a path is required"),
        "{}",
        text(&output)
    );
}

#[test]
fn a_date_that_is_not_rfc_3339_is_refused() {
    let (_temp, target) = init(&["--kind", "journal", "--no-encrypt"]);
    let output = fjord(&["-C", &target, "new", "--no-edit", "--date", "yesterday"]);
    assert_eq!(code(&output), 2, "{}", text(&output));
    let output = fjord(&[
        "-C",
        &target,
        "new",
        "Public/a.md",
        "--date",
        "2026-11-02T00:30:00+05:30",
    ]);
    assert_eq!(code(&output), 2, "{}", text(&output));
}

/// A post made with no path in a site: filed as its engine reads it, dated in the writer's day, and a draft where the engine says so.
#[test]
fn new_with_no_path_writes_a_site_s_post_as_its_engine_reads_it() {
    let (_astro_dir, astro) = init(&["--kind", "ssg", "--engine", "astro"]);
    let made = fjord(&[
        "-C",
        &astro,
        "new",
        "--no-edit",
        "--title",
        "Hello, World!",
        "--date",
        "2026-11-02T00:30:00+05:30",
    ]);
    assert_eq!(code(&made), 0, "{}", text(&made));
    let post = std::fs::read_to_string(Path::new(&astro).join("content/posts/hello-world.md"))
        .expect("the post");
    assert!(
        post.contains("title: Hello, World!")
            && post.contains("date: \"2026-11-02T00:30:00+05:30\""),
        "{post}"
    );
    assert!(!post.contains("draft"), "{post}");
    let draft = fjord(&[
        "-C",
        &astro,
        "new",
        "--no-edit",
        "--title",
        "Not yet",
        "--draft",
    ]);
    assert_eq!(code(&draft), 0, "{}", text(&draft));
    let hidden = std::fs::read_to_string(Path::new(&astro).join("content/posts/not-yet.md"))
        .expect("the draft");
    assert!(hidden.contains("draft: true"), "{hidden}");
    assert_eq!(codes(&verify(&astro)), Vec::<String>::new());

    let (_jekyll_dir, jekyll) = init(&["--kind", "ssg", "--engine", "jekyll"]);
    let made = fjord(&[
        "-C",
        &jekyll,
        "new",
        "--no-edit",
        "--title",
        "First light",
        "--date",
        "2026-11-02T00:30:00+05:30",
    ]);
    assert_eq!(code(&made), 0, "{}", text(&made));
    // The name is a rule in Jekyll: the writer's day, then the slug.
    assert!(Path::new(&jekyll)
        .join("content/_posts/2026-11-02-first-light.md")
        .is_file());
    let draft = fjord(&[
        "-C",
        &jekyll,
        "new",
        "--no-edit",
        "--title",
        "Later",
        "--draft",
    ]);
    assert_eq!(code(&draft), 0, "{}", text(&draft));
    let hidden = std::fs::read_to_string(Path::new(&jekyll).join("content/_drafts/later.md"))
        .expect("the draft");
    assert!(
        !hidden.contains("draft"),
        "Jekyll's draft is a folder: {hidden}"
    );
    assert_eq!(codes(&verify(&jekyll)), Vec::<String>::new());
}

#[test]
fn a_draft_needs_a_site_and_a_path_forbids_the_generated_options() {
    let (_dir, journal) = init(&["--kind", "journal", "--no-encrypt"]);
    let output = fjord(&["-C", &journal, "new", "--no-edit", "--draft"]);
    assert_eq!(code(&output), 2, "{}", text(&output));
    let output = fjord(&["-C", &journal, "new", "journal/a.md", "--draft"]);
    assert_eq!(code(&output), 2, "{}", text(&output));
}

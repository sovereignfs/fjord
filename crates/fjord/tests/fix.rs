// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord verify --fix`, and the conformance levels `verify --json` declares.
//!
//! The repair is exactly two things (`fjord_core::repair`): list a vault
//! that is on disk, drop an entry for one that is not. These tests run it on
//! copies of the broken fixtures, because it writes.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

/// A writable copy of a fixture.
fn copy_of(fixture: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    copy_tree(&fixtures().join(fixture), dir.path());
    dir
}

fn copy_tree(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).expect("read_dir") {
        let entry = entry.expect("entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("type").is_dir() {
            std::fs::create_dir_all(&target).expect("mkdir");
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copy");
        }
    }
}

fn fjord(root: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_fjord"))
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env("NO_COLOR", "1")
        .output()
        .expect("run fjord")
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn code_of(output: &Output) -> i32 {
    output.status.code().expect("exit code")
}

fn manifest(root: &Path) -> String {
    std::fs::read_to_string(root.join("fjord.json")).expect("read fjord.json")
}

#[test]
fn an_unlisted_vault_is_added_and_the_repository_is_then_clean() {
    let dir = copy_of("broken/W601");
    let before = manifest(dir.path());

    let output = fjord(dir.path(), &["verify", "--fix"]);
    assert_eq!(code_of(&output), 0, "{}", stdout_of(&output));
    assert!(
        stdout_of(&output).contains("added"),
        "{}",
        stdout_of(&output)
    );
    assert_ne!(manifest(dir.path()), before);

    let after = fjord(dir.path(), &["verify", "--strict"]);
    assert_eq!(
        code_of(&after),
        0,
        "still not clean after --fix:\n{}",
        stdout_of(&after)
    );
}

#[test]
fn a_listed_vault_that_is_gone_is_dropped() {
    let dir = copy_of("broken/E106");
    assert_eq!(code_of(&fjord(dir.path(), &["verify"])), 1);

    let output = fjord(dir.path(), &["verify", "--fix"]);
    assert_eq!(code_of(&output), 0, "{}", stdout_of(&output));
    assert!(
        stdout_of(&output).contains("removed"),
        "{}",
        stdout_of(&output)
    );
    assert_eq!(code_of(&fjord(dir.path(), &["verify"])), 0);
}

#[test]
fn a_second_run_has_nothing_to_do() {
    let dir = copy_of("broken/W601");
    fjord(dir.path(), &["verify", "--fix"]);
    let settled = manifest(dir.path());

    let output = fjord(dir.path(), &["verify", "--fix"]);
    assert_eq!(code_of(&output), 0);
    assert!(
        stdout_of(&output).contains("nothing to repair"),
        "{}",
        stdout_of(&output)
    );
    assert_eq!(manifest(dir.path()), settled);
}

#[test]
fn a_conforming_repository_is_left_byte_for_byte_alone() {
    let dir = copy_of("conforming");
    let before = manifest(dir.path());
    let output = fjord(dir.path(), &["verify", "--fix"]);
    assert_eq!(code_of(&output), 0, "{}", stdout_of(&output));
    assert_eq!(manifest(dir.path()), before);
}

#[test]
fn verify_without_fix_still_changes_nothing() {
    // Invariant 7: `verify` is read-only; `--fix` is the only way in.
    let dir = copy_of("broken/W601");
    let before = manifest(dir.path());
    fjord(dir.path(), &["verify"]);
    fjord(dir.path(), &["verify", "--json"]);
    assert_eq!(manifest(dir.path()), before);
}

#[test]
fn a_repository_from_a_newer_version_is_not_repaired() {
    // Invariant 4: never write to a repository whose version we do not
    // implement — and `--fix` is a write.
    let dir = copy_of("broken/W601");
    let text = manifest(dir.path()).replacen("\"fjord\": 1", "\"fjord\": 2", 1);
    assert!(text.contains("\"fjord\": 2"), "fixture format changed");
    std::fs::write(dir.path().join("fjord.json"), &text).expect("write");

    let output = fjord(dir.path(), &["verify", "--fix"]);
    assert_eq!(code_of(&output), 2);
    assert_eq!(manifest(dir.path()), text);
}

#[test]
fn unknown_manifest_keys_survive_a_repair() {
    // Invariant 3.
    let dir = copy_of("broken/W601");
    let mut document: Value = serde_json::from_str(&manifest(dir.path())).expect("json");
    document["futureField"] = serde_json::json!({ "kept": true });
    std::fs::write(
        dir.path().join("fjord.json"),
        serde_json::to_string_pretty(&document).expect("serialise"),
    )
    .expect("write");

    assert_eq!(code_of(&fjord(dir.path(), &["verify", "--fix"])), 0);
    let repaired: Value = serde_json::from_str(&manifest(dir.path())).expect("json");
    assert_eq!(repaired["futureField"]["kept"], true);
}

#[test]
fn json_lists_what_was_repaired_and_nothing_else_on_stdout() {
    let dir = copy_of("broken/W601");
    let output = fjord(dir.path(), &["verify", "--fix", "--json"]);
    let document: Value = serde_json::from_str(&stdout_of(&output))
        .unwrap_or_else(|err| panic!("stdout is not only JSON: {err}\n{}", stdout_of(&output)));
    let repairs = document["repairs"].as_array().expect("repairs array");
    assert_eq!(repairs.len(), 1, "{repairs:?}");
    assert_eq!(repairs[0]["action"], "added");

    // Absent without --fix: "no repair was attempted" is not "none needed".
    let plain = fjord(dir.path(), &["verify", "--json"]);
    let document: Value = serde_json::from_str(&stdout_of(&plain)).expect("json");
    assert!(document.get("repairs").is_none());
}

#[test]
fn json_declares_the_conformance_levels() {
    let output = fjord(&fixtures().join("conforming"), &["verify", "--json"]);
    let document: Value = serde_json::from_str(&stdout_of(&output)).expect("json");
    assert_eq!(
        document["conformance"],
        serde_json::json!(["L0", "L1", "L2", "L3"])
    );
}

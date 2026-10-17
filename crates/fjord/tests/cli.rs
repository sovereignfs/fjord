// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end tests for the `fjord` binary: exit codes, golden output, and
//! `--json` against the published schema.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn schema() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/verify.schema.json")
}

/// Run the binary against a fixture.
fn fjord(fixture: &str, arguments: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
    command
        .arg("-C")
        .arg(fixtures().join(fixture))
        .args(arguments)
        // Deterministic output: no escape codes regardless of where the
        // test runs.
        .env("NO_COLOR", "1");
    match command.output() {
        Ok(output) => output,
        Err(err) => panic!("could not run the fjord binary: {err}"),
    }
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn code_of(output: &Output) -> i32 {
    match output.status.code() {
        Some(code) => code,
        None => panic!("fjord was killed by a signal"),
    }
}

// --- Exit codes ----------------------------------------------------------

#[test]
fn a_conforming_repository_exits_zero() {
    let output = fjord("conforming", &["verify"]);
    assert_eq!(code_of(&output), 0, "stdout: {}", stdout_of(&output));
}

#[test]
fn an_error_exits_one() {
    assert_eq!(code_of(&fjord("broken/E201", &["verify"])), 1);
}

#[test]
fn a_warning_alone_exits_zero_unless_strict() {
    assert_eq!(code_of(&fjord("broken/W601", &["verify"])), 0);
    assert_eq!(code_of(&fjord("broken/W601", &["verify", "--strict"])), 1);
}

#[test]
fn fix_is_refused_as_a_usage_error() {
    // Not silently ignored: a user who passes --fix believes their
    // repository was repaired.
    let output = fjord("conforming", &["verify", "--fix"]);
    assert_eq!(code_of(&output), 2);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--fix"), "stderr was: {stderr}");
}

#[test]
fn quiet_prints_only_errors() {
    let output = fjord("broken/E201", &["verify", "--quiet"]);
    let stdout = stdout_of(&output);
    assert_eq!(stdout.lines().count(), 1, "stdout was: {stdout}");
    assert!(stdout.contains("E201"));
    assert!(stdout.contains("Private/notes.md"));
}

// --- Golden output -------------------------------------------------------

/// Snapshot the human-readable report, so a formatting change is a
/// deliberate act rather than a surprise.
///
/// Run with `FJORD_UPDATE_GOLDEN=1` to rewrite the expectations, then read
/// the diff before committing it.
fn assert_golden(name: &str, actual: &str) {
    let path = golden().join(format!("{name}.txt"));

    if std::env::var_os("FJORD_UPDATE_GOLDEN").is_some() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&path, actual).expect("write golden file");
        return;
    }

    let expected = match std::fs::read_to_string(&path) {
        Ok(expected) => expected,
        Err(err) => panic!(
            "missing golden file {}: {err}\n\
             Run with FJORD_UPDATE_GOLDEN=1 to create it. Actual output was:\n{actual}",
            path.display()
        ),
    };

    assert_eq!(
        actual,
        expected,
        "\n{} is out of date. Re-run with FJORD_UPDATE_GOLDEN=1 if the change is intended.\n",
        path.display()
    );
}

#[test]
fn golden_conforming() {
    assert_golden("conforming", &stdout_of(&fjord("conforming", &["verify"])));
}

#[test]
fn golden_plaintext_in_encrypted_vault() {
    assert_golden("E201", &stdout_of(&fjord("broken/E201", &["verify"])));
}

/// A repository that conforms but has something to say. The mark must be
/// `⚠`, not `✗`: this exits 0.
#[test]
fn golden_warning_only() {
    assert_golden("W601", &stdout_of(&fjord("broken/W601", &["verify"])));
}

#[test]
fn golden_unsupported_version() {
    assert_golden("E103", &stdout_of(&fjord("broken/E103", &["verify"])));
}

// --- The JSON contract ---------------------------------------------------

#[test]
fn json_output_matches_the_published_schema() {
    // Every fixture, so that each branch of the output shape — a null
    // formatVersion, an empty vault list, a diagnostic with no path — is
    // covered by the contract rather than only the happy path.
    let mut checked = 0;
    for fixture in fixture_names() {
        let output = fjord(&fixture, &["verify", "--json"]);
        let stdout = stdout_of(&output);
        let document: Value = match serde_json::from_str(&stdout) {
            Ok(document) => document,
            Err(err) => panic!("{fixture}: --json output is not JSON: {err}\n{stdout}"),
        };

        let mut problems = Vec::new();
        validate(&document, &load_schema(), "$", &mut problems);
        assert!(
            problems.is_empty(),
            "{fixture}: --json output does not match the schema:\n  {}",
            problems.join("\n  ")
        );
        checked += 1;
    }
    assert!(checked > 25, "only {checked} fixtures were checked");
}

#[test]
fn json_reports_the_code_and_its_path() {
    let output = fjord("broken/E201", &["verify", "--json"]);
    let document: Value = serde_json::from_str(&stdout_of(&output)).expect("JSON");

    assert_eq!(document["conforms"], Value::Bool(false));
    assert_eq!(document["counts"]["errors"], Value::from(1));
    assert_eq!(document["counts"]["warnings"], Value::from(0));

    let diagnostics = document["diagnostics"].as_array().expect("diagnostics");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["code"], Value::from("E201"));
    assert_eq!(diagnostics[0]["severity"], Value::from("error"));
    assert_eq!(diagnostics[0]["path"], Value::from("Private/notes.md"));
}

#[test]
fn json_marks_a_newer_repository_read_only() {
    let output = fjord("broken/E103", &["verify", "--json"]);
    let document: Value = serde_json::from_str(&stdout_of(&output)).expect("JSON");
    assert_eq!(document["readOnly"], Value::Bool(true));
    assert_eq!(document["formatVersion"], Value::from(2));
}

#[test]
fn json_handles_a_repository_with_no_manifest() {
    let output = fjord("broken/E101", &["verify", "--json"]);
    let document: Value = serde_json::from_str(&stdout_of(&output)).expect("JSON");
    assert_eq!(document["formatVersion"], Value::Null);
    assert_eq!(document["vaults"].as_array().map(Vec::len), Some(0));
    let diagnostics = document["diagnostics"].as_array().expect("diagnostics");
    assert_eq!(diagnostics[0]["code"], Value::from("E101"));
    // A repository-wide finding carries no path.
    assert_eq!(diagnostics[0]["path"], Value::Null);
}

fn fixture_names() -> Vec<String> {
    let mut names = vec!["conforming".to_string()];
    let broken = fixtures().join("broken");
    let mut found: Vec<String> = std::fs::read_dir(&broken)
        .expect("broken fixtures")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| format!("broken/{}", entry.file_name().to_string_lossy()))
        .collect();
    found.sort();
    names.append(&mut found);
    names
}

fn load_schema() -> Value {
    let text = std::fs::read_to_string(schema()).expect("read schema/verify.schema.json");
    serde_json::from_str(&text).expect("schema is valid JSON")
}

/// A deliberately small JSON Schema checker.
///
/// It covers the keywords this schema actually uses — `type`, `required`,
/// `properties`, `additionalProperties: false`, `items`, `enum` and
/// `minimum` — which is enough to catch the drift that matters: a renamed
/// field, a changed type, a field added to the output but not to the
/// contract. It is **not** a conforming Draft 2020-12 validator; `pattern`
/// in particular is not checked, since that would mean a regex dependency.
/// Swapping in a real validator is a CI task, not a reason to leave the
/// output unchecked.
fn validate(value: &Value, schema: &Value, path: &str, problems: &mut Vec<String>) {
    if let Some(expected) = schema.get("type") {
        let actual = type_name(value);
        let permitted: Vec<&str> = match expected {
            Value::String(name) => vec![name.as_str()],
            Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !permitted.is_empty() && !permitted.contains(&actual) {
            problems.push(format!(
                "{path}: expected type {permitted:?}, found {actual}"
            ));
            return;
        }
    }

    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            problems.push(format!("{path}: {value} is not one of {allowed:?}"));
        }
    }

    if let (Some(minimum), Some(number)) = (
        schema.get("minimum").and_then(Value::as_f64),
        value.as_f64(),
    ) {
        if number < minimum {
            problems.push(format!("{path}: {number} is below the minimum {minimum}"));
        }
    }

    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    problems.push(format!("{path}: required field `{key}` is missing"));
                }
            }
        }

        let properties = schema.get("properties").and_then(Value::as_object);
        let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));

        for (key, member) in object {
            match properties.and_then(|properties| properties.get(key)) {
                Some(subschema) => validate(member, subschema, &format!("{path}.{key}"), problems),
                None if closed => problems.push(format!(
                    "{path}.{key}: present in the output but not in the schema"
                )),
                None => {}
            }
        }
    }

    if let Some(array) = value.as_array() {
        if let Some(items) = schema.get("items") {
            for (index, member) in array.iter().enumerate() {
                validate(member, items, &format!("{path}[{index}]"), problems);
            }
        }
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                "integer"
            } else {
                "number"
            }
        }
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

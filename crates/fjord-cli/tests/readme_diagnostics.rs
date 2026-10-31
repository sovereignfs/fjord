// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The README's diagnostics tables against `diagnostics::Code`.
//!
//! The enum is the single source of truth for which codes exist (CLAUDE.md, Conventions), and the README is
//! where people look them up. The README's meanings are longer than `Code::message` and some carry advice, so
//! the tables are written by hand and *held to the enum* here instead of generated from it: a code added
//! without a row, a row for a code that is gone, a row under the wrong heading, a warning listed as an error,
//! or a gap in the numbers that the README does not say is reserved, each fails this test.

use std::collections::{BTreeMap, BTreeSet};

use fjord_core::diagnostics::{Code, Severity};

/// The README's "Diagnostics" section: for each heading, its table rows (code, meaning), and the codes it
/// declares reserved.
struct Section {
    rows: BTreeMap<String, Vec<(String, String)>>,
    reserved: BTreeSet<String>,
}

fn readme_section() -> Section {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/README.md"))
        .expect("the CLI's README is there");
    let start = text
        .find("\n## Diagnostics\n")
        .expect("the README has a Diagnostics section")
        + 1;
    let body = &text[start..];
    let end = body[3..].find("\n## ").map_or(body.len(), |i| i + 3);
    let body = &body[..end];

    let mut rows: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut reserved = BTreeSet::new();
    let mut heading = String::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("### ") {
            // "What `--fix` does" is not a table of codes.
            heading = rest.to_string();
        } else if let Some(row) = line.strip_prefix("| `") {
            if let Some((code, meaning)) = row.split_once("` | ") {
                rows.entry(heading.clone())
                    .or_default()
                    .push((code.to_string(), meaning.trim_end_matches(" |").to_string()));
            }
        } else if line.contains("are reserved") {
            // "`E107`, `E205` and `W603` are reserved: ..."
            reserved.extend(line.split('`').skip(1).step_by(2).map(str::to_string));
        }
    }
    Section { rows, reserved }
}

fn group_of(code: &str) -> &'static str {
    match code.get(..2) {
        Some("E1") => "Repository — `E1xx`",
        Some("E2") => "Vault — `E2xx`",
        Some("E3") => "Encryption — `E3xx`",
        Some("E4") => "Documents — `E4xx`",
        Some("E5") => "Paths — `E5xx`",
        Some("W6") => "Warnings — `W6xx`",
        _ => panic!("{code} is in no group; add its group to this test and to the README"),
    }
}

#[test]
fn every_code_has_one_row_under_its_own_heading() {
    let section = readme_section();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for (heading, rows) in &section.rows {
        for (code, meaning) in rows {
            assert!(!meaning.is_empty(), "{code} has no meaning in the README");
            assert!(seen.insert(code), "{code} is in the README twice");
            let real = Code::all()
                .iter()
                .find(|c| c.as_str() == code)
                .unwrap_or_else(|| panic!("the README lists {code}, which is not a code"));
            assert_eq!(
                group_of(code),
                heading,
                "{code} is under the wrong heading in the README"
            );
            let warning = matches!(real.severity(), Severity::Warning);
            assert_eq!(
                warning,
                code.starts_with('W'),
                "{code}'s severity and its prefix disagree"
            );
        }
    }
    for code in Code::all() {
        assert!(
            seen.contains(code.as_str()),
            "{} ({:?}) has no row in the README's diagnostics tables",
            code.as_str(),
            code
        );
    }
}

#[test]
fn the_gaps_in_the_numbers_are_exactly_the_ones_the_readme_calls_reserved() {
    let section = readme_section();
    let assigned: BTreeSet<&str> = Code::all().iter().map(|c| c.as_str()).collect();
    // Within each hundred, every number up to the highest assigned is either a code or reserved.
    let mut gaps = BTreeSet::new();
    for group in ["E1", "E2", "E3", "E4", "E5", "W6"] {
        let highest = assigned
            .iter()
            .filter(|c| c.starts_with(group))
            .map(|c| c[1..].parse::<u32>().unwrap())
            .max()
            .expect("every group has a code");
        for number in (group[1..].parse::<u32>().unwrap() * 100 + 1)..=highest {
            let code = format!("{}{number:03}", &group[..1]);
            if !assigned.contains(code.as_str()) {
                gaps.insert(code);
            }
        }
    }
    assert_eq!(
        gaps, section.reserved,
        "the README's reserved codes and the gaps in the enum differ"
    );
}

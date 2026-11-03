// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The README's command reference is held to the CLI: every command, subcommand and flag that `fjord --help` reports
//! is written about in the README, in its own command's section.
//!
//! `readme_diagnostics.rs` does the same for the diagnostic codes. Without this one a flag could be added in `cli.rs` and
//! never documented, which is how `--draft` went missing: the README is what a person reads and what an agent is
//! pointed at, so it must not fall behind the code unseen.
//!
//! It reads the binary's own help rather than `cli.rs`, so it checks what a user is actually offered. It does not check
//! that the README is *right* about a flag, only that it says something about it where a reader will look.

use std::path::Path;
use std::process::Command;

fn help(arguments: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(arguments)
        .arg("--help")
        .output()
        .expect("run the fjord binary");
    assert!(output.status.success(), "fjord {arguments:?} --help failed");
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn readme() -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("README.md"))
        .expect("README.md")
}

/// The names under `Commands:` in a command's help.
fn commands_of(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if line.starts_with("Commands:") {
            inside = true;
        } else if inside {
            // A command line is indented two spaces; the block ends at the first line that is not.
            let Some(rest) = line.strip_prefix("  ") else {
                break;
            };
            if let Some(name) = rest.split_whitespace().next() {
                if name != "help" {
                    found.push(name.to_string());
                }
            }
        }
    }
    found
}

/// Every `--long` flag a command offers, from its help. An option line starts with a dash after at most six spaces;
/// a description that wraps onto a line is indented further, so it is not mistaken for one.
fn flags_of(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in text.lines() {
        let indent = line.len() - line.trim_start().len();
        if indent == 0 || indent > 6 || !line.trim_start().starts_with('-') {
            continue;
        }
        for token in line.split_whitespace().take(3) {
            let token = token.trim_end_matches(',');
            if let Some(name) = token.strip_prefix("--") {
                let name = name.split(['=', '<']).next().unwrap_or(name);
                if !name.is_empty() && name != "help" && name != "version" {
                    found.push(format!("--{name}"));
                }
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

/// The README text of one `###` section: from the heading that names `fjord <command>` to the next `##` or `###`.
fn section_of(readme: &str, command: &str) -> Option<String> {
    let needle = format!("`fjord {command}");
    let mut lines = readme
        .lines()
        .skip_while(|line| !(line.starts_with("### ") && line.contains(&needle)));
    let heading = lines.next()?;
    let mut text = String::from(heading);
    for line in lines {
        if line.starts_with("## ") || line.starts_with("### ") {
            break;
        }
        text.push('\n');
        text.push_str(line);
    }
    Some(text)
}

#[test]
fn every_command_has_a_section_and_a_line_in_the_overview() {
    let readme = readme();
    let overview = overview(&readme);
    let mut missing = Vec::new();
    for command in commands_of(&help(&[])) {
        if section_of(&readme, &command).is_none() {
            missing.push(format!("no `### fjord {command}` section"));
        }
        if !overview.contains(&format!("`fjord {command}")) {
            missing.push(format!(
                "`fjord {command}` is not in \"Commands at a glance\""
            ));
        }
    }
    assert!(
        missing.is_empty(),
        "the README is behind the CLI:\n  {}",
        missing.join("\n  ")
    );
}

#[test]
fn every_flag_of_every_command_is_in_that_commands_section() {
    let readme = readme();
    let global = flags_of(&help(&[]));
    let mut missing = Vec::new();

    for command in commands_of(&help(&[])) {
        let Some(section) = section_of(&readme, &command) else {
            continue; // reported by the test above
        };
        let own = help(&[&command]);
        // A command with subcommands (`key`, `vault`) lists theirs in the same section, with their flags.
        let mut offered: Vec<(String, Vec<String>)> = vec![(command.clone(), flags_of(&own))];
        for sub in commands_of(&own) {
            if !section.contains(&format!("fjord {command} {sub}"))
                && !section.contains(&format!("`{sub}`"))
                && !section.contains(&format!("{command} {sub}"))
            {
                missing.push(format!(
                    "`fjord {command} {sub}` is not described in the `fjord {command}` section"
                ));
            }
            offered.push((
                format!("{command} {sub}"),
                flags_of(&help(&[&command, &sub])),
            ));
        }
        for (name, flags) in offered {
            for flag in flags.iter().filter(|flag| !global.contains(flag)) {
                if !section.contains(flag.as_str()) {
                    missing.push(format!("`fjord {name}` has {flag}, which the `fjord {command}` section does not mention"));
                }
            }
        }
    }
    assert!(
        missing.is_empty(),
        "the README is behind the CLI:\n  {}",
        missing.join("\n  ")
    );
}

#[test]
fn the_options_every_command_takes_are_described_once() {
    let readme = readme();
    let mut missing = Vec::new();
    for flag in flags_of(&help(&[])) {
        if !readme.contains(&flag) {
            missing.push(flag);
        }
    }
    assert!(
        missing.is_empty(),
        "these options of every command are not in the README: {missing:?}"
    );
}

/// The "Commands at a glance" section, which a person skims first.
fn overview(readme: &str) -> String {
    readme
        .lines()
        .skip_while(|line| !line.starts_with("## Commands at a glance"))
        .skip(1)
        .take_while(|line| !line.starts_with("## "))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The parsers above are what the checks stand on, so they are checked against the help they read.
#[test]
fn the_parsers_read_the_help_they_are_given() {
    let commands = commands_of(&help(&[]));
    for expected in [
        "init", "verify", "new", "key", "vault", "export", "import", "sync",
    ] {
        assert!(
            commands.iter().any(|command| command == expected),
            "{expected} is not read from `fjord --help`: {commands:?}"
        );
    }
    assert!(!commands.iter().any(|command| command == "help"));

    let init = flags_of(&help(&["init"]));
    for expected in [
        "--kind",
        "--engine",
        "--no-encrypt",
        "--adopt",
        "--vault",
        "--encrypt-existing",
        "--no-git",
        "--no-input",
        "--json",
    ] {
        assert!(
            init.iter().any(|flag| flag == expected),
            "{expected} is not read from `fjord init --help`: {init:?}"
        );
    }
    // The long help of `new` wraps its descriptions; a wrapped line is not an option.
    let new = flags_of(&help(&["new"]));
    for expected in ["--draft", "--date", "--title"] {
        assert!(
            new.iter().any(|flag| flag == expected),
            "{expected} is not read from `fjord new --help`: {new:?}"
        );
    }
    assert_eq!(
        commands_of(&help(&["key"])),
        ["new", "add", "list", "remove"]
    );
    assert_eq!(commands_of(&help(&["vault"])), ["add", "list"]);
}

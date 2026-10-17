// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord status` — repository health and sync state.
//!
//! Three questions in one answer: does the repository conform, what has
//! changed since the last commit, and where is it relative to its remote.
//! Everything here is read-only.

use crate::cli::{ExitCode, GlobalArgs};
use crate::cmd::{find_root, plural, Style};
use crate::git::Git;
use anyhow::{Context, Result};
use fjord_core::verify::{self, Options};

pub fn run(global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;

    let report =
        verify::verify(&root, &Options::default()).context("could not check the repository")?;

    let repository = Git::new(&root);
    let git = if repository.is_repository() {
        Some(GitState {
            branch: repository.current_branch().unwrap_or(None),
            changes: repository.changed_paths().unwrap_or_default(),
            conflicts: repository.unmerged_paths().unwrap_or_default(),
            ahead_behind: repository.ahead_behind().unwrap_or(None),
        })
    } else {
        None
    };

    if global.json {
        println!("{}", render_json(&report, git.as_ref()));
        return Ok(ExitCode::Ok);
    }

    let style = Style::detect();

    for vault in &report.vaults {
        let summary = if vault.encrypted {
            // Deliberately no doc count: nothing here was decrypted, so a
            // Doc is indistinguishable from any other file. `fjord ls
            // --long` reads frontmatter and can tell you.
            format!(
                "encrypted · {} · {}",
                plural(vault.recipients, "recipient", "recipients"),
                plural(vault.files, "file", "files")
            )
        } else {
            format!(
                "plaintext · {} · {}",
                plural(vault.docs, "doc", "docs"),
                plural(vault.files, "file", "files")
            )
        };
        println!("  {:<12}{}", vault.path, style.dim(&summary));
    }

    println!();
    if report.conforms() && report.warnings() == 0 {
        println!("  {} the repository conforms", style.good("✓"));
    } else {
        let marker = if report.conforms() {
            style.warning("⚠")
        } else {
            style.error("✗")
        };
        println!(
            "  {marker} {}, {} — run `fjord verify` for detail",
            plural(report.errors(), "error", "errors"),
            plural(report.warnings(), "warning", "warnings")
        );
    }

    match &git {
        None => {
            println!("  {}", style.dim("not a git repository"));
        }
        Some(git) => {
            if let Some(branch) = &git.branch {
                print!("  {} on {branch}", style.dim("git"));
                match git.ahead_behind {
                    Some((0, 0)) => println!(", up to date with its remote"),
                    Some((ahead, 0)) => {
                        println!(", {} to push", plural(ahead, "commit", "commits"))
                    }
                    Some((0, behind)) => {
                        println!(", {} to pull", plural(behind, "commit", "commits"))
                    }
                    Some((ahead, behind)) => println!(
                        ", {} to push and {} to pull",
                        plural(ahead, "commit", "commits"),
                        plural(behind, "commit", "commits")
                    ),
                    None => println!(", no remote tracked"),
                }
            }

            if git.changes.is_empty() {
                println!("  {}", style.dim("nothing to commit"));
            } else {
                println!(
                    "  {} uncommitted",
                    plural(git.changes.len(), "change", "changes")
                );
                for path in git.changes.iter().take(10) {
                    println!("    {path}");
                }
                if git.changes.len() > 10 {
                    println!(
                        "    {}",
                        style.dim(&format!("and {} more", git.changes.len() - 10))
                    );
                }
            }

            if !git.conflicts.is_empty() {
                println!();
                println!(
                    "  {} {}",
                    style.error("conflicts:"),
                    plural(git.conflicts.len(), "file", "files")
                );
                for path in &git.conflicts {
                    println!("    {path}");
                }
                println!();
                println!("  Git cannot merge ciphertext. Run `fjord sync` to resolve these by");
                println!("  decrypting both sides, merging the plaintext and re-encrypting.");
            }
        }
    }

    if report.read_only {
        println!();
        println!(
            "  {} made by a newer version of Fjord: readable, not writable",
            style.warning("read-only:")
        );
    }

    Ok(ExitCode::Ok)
}

#[derive(Debug)]
struct GitState {
    branch: Option<String>,
    changes: Vec<String>,
    conflicts: Vec<String>,
    ahead_behind: Option<(usize, usize)>,
}

fn render_json(report: &verify::Report, git: Option<&GitState>) -> String {
    let vaults: Vec<serde_json::Value> = report
        .vaults
        .iter()
        .map(|vault| {
            serde_json::json!({
                "path": vault.path,
                "encrypted": vault.encrypted,
                "recipients": vault.recipients,
                "docs": vault.docs,
                "files": vault.files,
            })
        })
        .collect();

    let git = match git {
        Some(git) => serde_json::json!({
            "branch": git.branch,
            "changes": git.changes,
            "conflicts": git.conflicts,
            "ahead": git.ahead_behind.map(|(ahead, _)| ahead),
            "behind": git.ahead_behind.map(|(_, behind)| behind),
        }),
        None => serde_json::Value::Null,
    };

    let document = serde_json::json!({
        "conforms": report.conforms(),
        "readOnly": report.read_only,
        "counts": { "errors": report.errors(), "warnings": report.warnings() },
        "vaults": vaults,
        "git": git,
    });
    serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string())
}

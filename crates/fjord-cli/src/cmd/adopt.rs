// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord init --adopt` — make a Fjord repository of a directory that already has files. RFC 0002.
//!
//! The plan is `fjord_core::adopt::plan_adopt`'s, the same one every client will ask; this module finds
//! out what is in the directory, decides what the flags mean, writes the plan, and commits it.
//!
//! The rules it keeps:
//!
//! - **It writes over nothing.** A new file is created exclusively; `.gitattributes` and `.gitignore` are
//!   the only two that are ever changed, and only by adding lines at their end.
//! - **It commits only what it wrote.** In a repository that is already there it stages and commits those
//!   paths and nothing else, so a person's uncommitted work stays uncommitted. Where there is no
//!   repository it makes one, and commits only Fjord's files too: the person's own are theirs to add.
//! - **Plaintext never gets into an encrypted vault unrecorded.** Encrypting a directory that already holds
//!   files (`--encrypt-existing`) begins a checkout (spec §6.6) *before* the vault's manifest exists, and
//!   makes no commit: nothing can be committed until `fjord encrypt <vault>` ends it.

use crate::cli::{ExitCode, GlobalArgs, InitArgs};
use crate::cmd::{checkout, usage, Style};
use crate::git::{Git, DEFAULT_BRANCH};
use anyhow::{Context, Result};
use fjord_core::adopt::{self, AdoptError, AdoptKind, AdoptedVault, Adoption};
use fjord_core::scaffold::{self, FileChange, SiteEngine, JOURNAL_VAULT, PUBLIC_VAULT};
use fjord_core::scalar;
use serde_json::json;
use std::path::{Path, PathBuf};

pub fn run(args: &InitArgs, global: &GlobalArgs) -> Result<ExitCode> {
    if global.identity.is_some() {
        return Ok(usage(
            "an identity cannot be registered here. Add the key afterwards with `fjord key add`",
        ));
    }
    let target = args.path.clone().unwrap_or_else(|| PathBuf::from("."));
    if !target.is_dir() {
        return Ok(usage(format!(
            "{} is not a directory. `--adopt` makes a repository of a directory that already has \
             files; without it `fjord init` makes a new one",
            target.display()
        )));
    }
    let root = std::fs::canonicalize(&target)
        .with_context(|| format!("could not resolve {}", target.display()))?;

    let existing = list_files(&root)?;
    let gitattributes = read_text(&root, ".gitattributes", &existing)?;
    let gitignore = read_text(&root, ".gitignore", &existing)?;

    // What kind, which engine, and which directories.
    let kind_name = args.kind.as_deref().unwrap_or("drive");
    if args.no_encrypt && args.encrypt_existing {
        return Ok(usage(
            "--no-encrypt and --encrypt-existing disagree: one leaves the files readable, the other \
             encrypts them. Give one",
        ));
    }
    if kind_name == "ssg" && args.encrypt_existing {
        return Ok(usage(
            "a site's content is never encrypted: it is published (spec §3.1), so --encrypt-existing \
             has nothing to do",
        ));
    }
    let detected = adopt::detect_site(&existing);
    let kind =
        match kind_name {
            "journal" => AdoptKind::Journal,
            "ssg" => {
                let engine = match args.engine.as_deref() {
                    Some(name) => SiteEngine::parse(name),
                    None => detected.as_ref().map(|site| site.engine),
                };
                match engine {
                    Some(engine) => AdoptKind::Ssg(engine),
                    None => return Ok(usage(
                        "--kind ssg needs --engine astro or --engine jekyll: no engine's files \
                         (astro.config.*, _config.yml) were found here to tell which",
                    )),
                }
            }
            _ => AdoptKind::Drive,
        };

    let paths: Vec<String> = match (kind, args.vault.is_empty()) {
        (_, false) => args.vault.clone(),
        (AdoptKind::Ssg(engine), true) => match detected.filter(|site| site.engine == engine) {
            Some(site) => vec![site.content.to_string()],
            None => {
                return Ok(usage(
                    "name the folder the site's content is in with --vault, such as \
                     `--vault src/content`",
                ))
            }
        },
        (AdoptKind::Journal, true) => vec![default_vault(JOURNAL_VAULT, &existing)],
        (AdoptKind::Drive, true) => vec![default_vault(PUBLIC_VAULT, &existing)],
    };

    let mut vaults = Vec::new();
    for path in &paths {
        let key = path.trim_end_matches('/');
        let holds_files = existing
            .iter()
            .any(|there| there.starts_with(&format!("{key}/")));
        let encrypted = match kind {
            AdoptKind::Ssg(_) => false,
            _ if args.encrypt_existing => true,
            _ if args.no_encrypt => false,
            // A journal is private by nature, so a new one is encrypted. One that is a directory of notes
            // already is a choice about those notes, and it is not made silently either way.
            AdoptKind::Journal if holds_files => {
                return Ok(usage(format!(
                    "{key} already has files in it, so whether the journal is encrypted is yours to \
                     say. `--no-encrypt` leaves them readable as they are; `--encrypt-existing` \
                     encrypts them (they stay in the clear until `fjord encrypt` checks them in, and \
                     git's history keeps what was committed)"
                )))
            }
            AdoptKind::Journal => true,
            AdoptKind::Drive => false,
        };
        vaults.push(AdoptedVault {
            path: key.to_string(),
            encrypted,
        });
    }

    let name = args.name.clone().unwrap_or_else(|| {
        root.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Fjord".to_string())
    });
    let adoption = Adoption {
        repository_name: name,
        generator: concat!("fjord ", env!("CARGO_PKG_VERSION")).to_string(),
        kind,
        vaults,
    };
    let vault_ids: Vec<String> = adoption.vaults.iter().map(|_| scalar::new_ulid()).collect();
    let plan = match adopt::plan_adopt(
        &adoption,
        &scalar::new_ulid(),
        &scalar::now_rfc3339_utc(),
        &vault_ids,
        &existing,
        gitattributes.as_deref(),
        gitignore.as_deref(),
    ) {
        Ok(plan) => plan,
        Err(error) => return Ok(usage(explain(&error))),
    };

    // Checked before writing, so a missing git never leaves a repository half-made.
    if !args.no_git && !Git::is_available() {
        anyhow::bail!(
            "`git` is not on PATH. Install it, or pass --no-git to make the repository without it"
        );
    }

    // Encrypting what is already there: a checkout first, then everything else.
    let checkouts: Vec<&str> = plan
        .vaults
        .iter()
        .filter(|vault| vault.encrypted && vault.holds_files)
        .map(|vault| vault.path.as_str())
        .collect();
    for (index, vault) in checkouts.iter().enumerate() {
        if let Err(error) = checkout::begin_adopted(&root, vault) {
            for begun in &checkouts[..index] {
                checkout::abandon_adopted(&root, begun);
            }
            return Err(error).context("could not begin the checkout, so nothing was written");
        }
    }

    let mut written: Vec<&str> = Vec::new();
    for file in &plan.files {
        let at = root.join(&file.path);
        let result = (|| -> std::io::Result<()> {
            if let Some(parent) = at.parent() {
                std::fs::create_dir_all(parent)?;
            }
            match file.change {
                FileChange::Create => {
                    use std::io::Write;
                    // `create_new` is the guarantee: it fails rather than truncating.
                    std::fs::File::create_new(&at)?.write_all(file.contents.as_bytes())
                }
                // The plan's text begins with what was there; this is that text with lines added.
                FileChange::Append => std::fs::write(&at, file.contents.as_bytes()),
            }
        })();
        if let Err(error) = result {
            return Err(error).with_context(|| {
                format!(
                    "could not write {} (written before it: {}). Nothing that was there was changed \
                     but {}",
                    file.path,
                    if written.is_empty() {
                        "nothing".to_string()
                    } else {
                        written.join(", ")
                    },
                    "`.gitattributes` and `.gitignore`, which only gain lines"
                )
            });
        }
        written.push(&file.path);
    }

    // Git. A checkout forbids committing, so with one there is no commit.
    let mut committed = false;
    if !args.no_git {
        let git = Git::new(&root);
        if !git.is_repository() {
            git.init(DEFAULT_BRANCH)?;
        }
        if checkouts.is_empty() {
            let paths: Vec<&str> = plan.files.iter().map(|file| file.path.as_str()).collect();
            git.add_paths(&paths).with_context(|| {
                "the repository was made, but git did not take its files. Fix the problem below, \
                 then stage and commit the files listed by `fjord verify`"
            })?;
            git.commit_paths("Adopt as a Fjord repository", &paths)?;
            committed = true;
        }
    }

    if global.json {
        println!(
            "{}",
            json!({
                "path": root.display().to_string(),
                "kind": kind_name,
                "adopted": true,
                "vaults": plan.vaults.iter().map(|vault| json!({
                    "path": vault.path,
                    "encrypted": vault.encrypted,
                    "holdsFiles": vault.holds_files,
                    "checkout": vault.encrypted && vault.holds_files,
                })).collect::<Vec<_>>(),
                "files": plan.files.iter().map(|file| json!({
                    "path": file.path,
                    "change": match file.change { FileChange::Create => "created", FileChange::Append => "appended" },
                })).collect::<Vec<_>>(),
                "committed": committed,
            })
        );
    } else if !global.quiet {
        report(&root, &plan, &checkouts, committed, Style::detect());
    }
    Ok(ExitCode::Ok)
}

/// The vault to adopt when none is named: `preferred`, which is the directory of that name if there is one
/// (a `journal/` that is already there is plainly the journal), else a name that is free. Only a *file*
/// of that name gets in the way.
fn default_vault(preferred: &str, existing: &[String]) -> String {
    if existing.iter().any(|path| path == preferred) {
        scaffold::free_vault_name(preferred, existing)
    } else {
        preferred.to_string()
    }
}

/// What the person is told, in words.
fn explain(error: &AdoptError) -> String {
    match error {
        AdoptError::AlreadyFjord => {
            "this directory already has a fjord.json, so it is a Fjord repository already"
                .to_string()
        }
        other => other.to_string(),
    }
}

fn report(root: &Path, plan: &adopt::AdoptPlan, checkouts: &[&str], committed: bool, style: Style) {
    println!(
        "  {} in {}",
        style.good("adopted as a Fjord repository"),
        root.display()
    );
    println!();
    for vault in &plan.vaults {
        let state = match (vault.encrypted, vault.holds_files) {
            (true, true) => "encrypted · files in the clear until checked in",
            (true, false) => "encrypted · no recipients yet",
            (false, _) => "plaintext",
        };
        println!("    {:<20}{}", format!("{}/", vault.path), style.dim(state));
    }
    println!();
    for file in &plan.files {
        let what = match file.change {
            FileChange::Create => "created ",
            FileChange::Append => "added to",
        };
        println!("    {} {}", style.dim(what), file.path);
    }
    println!();
    println!(
        "  {}",
        style.dim("Nothing that was there was changed, but lines added at the end of a file marked \"added to\".")
    );
    if !checkouts.is_empty() {
        println!();
        println!(
            "  {} Every version of these files that git already holds stays readable in its history,",
            style.warning("note:")
        );
        println!("  and only a new repository, or rewriting history, removes it (spec §11.4).");
        println!();
        println!(
            "  The files in {} are in the clear until you check them in:",
            checkouts.join(", ")
        );
        println!();
        println!("      age-keygen -o ~/.config/fjord/identity.txt");
        println!(
            "      age-keygen -y ~/.config/fjord/identity.txt >> {}/recipients.txt",
            checkouts[0]
        );
        for vault in checkouts {
            println!("      fjord encrypt {vault}");
        }
        println!();
        println!(
            "  {}",
            style.dim("Nothing can be committed until then, so nothing was.")
        );
    } else if committed {
        println!("  {}", style.dim("Committed: only the files above."));
    }
}

/// Every file under `root`, relative with forward slashes, not going into `.git` or the root `.fjord`,
/// or through a symbolic link to a directory.
fn list_files(root: &Path) -> Result<Vec<String>> {
    fn walk(base: &Path, relative: &str, out: &mut Vec<String>) -> Result<()> {
        let directory = if relative.is_empty() {
            base.to_path_buf()
        } else {
            base.join(relative)
        };
        for entry in std::fs::read_dir(&directory)
            .with_context(|| format!("could not read {}", directory.display()))?
        {
            let entry = entry.with_context(|| format!("could not read {}", directory.display()))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" || (relative.is_empty() && name == ".fjord") {
                continue;
            }
            let child = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let metadata = std::fs::symlink_metadata(entry.path())
                .with_context(|| format!("could not read {child}"))?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                walk(base, &child, out)?;
            } else {
                out.push(child);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, "", &mut files)?;
    files.sort();
    Ok(files)
}

/// The text of a root file, if the directory has it.
fn read_text(root: &Path, name: &str, existing: &[String]) -> Result<Option<String>> {
    if !existing.iter().any(|path| path == name) {
        return Ok(None);
    }
    let bytes = std::fs::read(root.join(name)).with_context(|| format!("could not read {name}"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| anyhow::anyhow!("{name} is not UTF-8 text, so lines cannot be added to it"))
}

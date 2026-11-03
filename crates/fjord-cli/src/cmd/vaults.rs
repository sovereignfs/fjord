// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord vault` — create and list vaults. Spec §2.3, §7.2.

use crate::cli::{ExitCode, GlobalArgs, VaultCommand};
use crate::cmd::{ensure_writable, find_root, plural, usage, Style};
use crate::git::Git;
use anyhow::{Context, Result};
use fjord_core::{scaffold, scalar, store, vault};

pub fn run(command: &VaultCommand, global: &GlobalArgs) -> Result<ExitCode> {
    match command {
        VaultCommand::Add {
            name,
            encrypted,
            id_naming,
            recipient,
            commit,
        } => add(name, *encrypted, *id_naming, recipient, *commit, global),
        VaultCommand::List => list(global),
    }
}

fn add(
    name: &str,
    encrypted: bool,
    id_naming: bool,
    recipients: &[String],
    commit: bool,
    global: &GlobalArgs,
) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }

    // Checked up front, like everything else, so that a request that cannot
    // be honoured creates nothing: a vault made and then not committed, when
    // a commit was asked for, is a half-done job.
    let repository = Git::new(&root);
    if commit && !repository.is_repository() {
        return Ok(usage(format!(
            "--commit needs a git repository, and {} is not one. `fjord init` creates \
             one, or leave --commit off",
            root.display()
        )));
    }

    // `--commit` stages the new vault directory and `fjord.json`, but a
    // commit made while another vault holds plaintext is not one to make
    // blind. Spec §6.5.
    if commit {
        if let Some(code) = crate::cmd::guard::ensure_nothing_in_the_clear(&root)? {
            return Ok(code);
        }
    }

    // Everything is decided by the planner `fjord-core` shares with the web client, before anything is written, so a request that
    // cannot be honoured creates nothing: a vault made with some of its keys is the worst result.
    let manifest_path = root.join(fjord_core::REPOSITORY_MANIFEST);
    let manifest_bytes = std::fs::read(&manifest_path).context("could not read fjord.json")?;
    let existing: Vec<String> = std::fs::read_dir(&root)
        .with_context(|| format!("could not read {}", root.display()))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    let gitattributes = std::fs::read_to_string(root.join(".gitattributes")).ok();

    let id = scalar::new_ulid();
    let created_at = scalar::now_rfc3339_utc();
    let setup = scaffold::VaultSetup {
        name: name.to_string(),
        encrypted,
        id_naming,
        recipients: recipients.to_vec(),
    };
    let plan = match scaffold::plan_vault(
        &setup,
        &manifest_bytes,
        &existing,
        gitattributes.as_deref(),
        &id,
        &created_at,
    ) {
        Ok(plan) => plan,
        Err(refusal) => return Ok(usage(refusal_message(&refusal, name))),
    };
    let accepted = plan.recipients.clone();
    let file_naming = if id_naming { "id" } else { "plain" };

    // The manifest first: a vault on disk that `fjord.json` does not list is only a warning (W601), while a manifest listing a vault
    // that was never created is an error (E106). The plan puts it first.
    let directory = root.join(name);
    let mut changed: Vec<&str> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    std::fs::create_dir(&directory)
        .with_context(|| format!("could not create {}", directory.display()))?;
    for file in &plan.files {
        let path = root.join(&file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
        std::fs::write(&path, &file.contents)
            .with_context(|| format!("could not write {}", file.path))?;
        if file.path.starts_with(&format!("{name}/")) {
            files.push(file.path.clone());
        } else {
            changed.push(&file.path);
        }
    }

    // Only the vault and what it changed outside itself (`fjord.json`, and `.gitattributes` if it gained the guard). See
    // `Git::commit_paths`: a bare commit would take everything staged.
    let message = format!("Add vault {name}");
    if commit {
        let mut paths: Vec<&str> = vec![name];
        paths.extend(changed.iter().copied());
        repository
            .add_paths(&paths)
            .and_then(|()| repository.commit_paths(&message, &paths))
            // The vault exists by now, and the user needs to know that: the
            // obvious next move is to run this again, and be told it exists.
            .with_context(|| {
                format!(
                    "the {name} vault was created, but could not be committed. Fix the \
                     problem below, then commit it yourself with `git add {name} \
                     {} && git commit`",
                    changed.join(" ")
                )
            })?;
    }

    if global.json {
        // The same facts `vault list --json` reports, plus what was just
        // made: the id, the recipients actually registered, and the files.
        let document = serde_json::json!({
            "path": name,
            "name": name,
            "id": id,
            "encrypted": encrypted,
            "fileNaming": file_naming,
            "container": if id_naming { "tar" } else { "none" },
            "recipients": accepted,
            "committed": commit,
            "files": files,
            "changed": changed,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string())
        );
        return Ok(ExitCode::Ok);
    }

    if !global.quiet {
        let style = Style::detect();
        let shape = match (encrypted, id_naming) {
            (false, _) => "plaintext".to_string(),
            (true, false) => "encrypted".to_string(),
            (true, true) => "encrypted, named by id".to_string(),
        };
        let keys = if encrypted && !accepted.is_empty() {
            format!(" · {}", plural(accepted.len(), "recipient", "recipients"))
        } else {
            String::new()
        };
        println!(
            "  {} {name}  {}",
            style.good("created"),
            style.dim(&format!("{shape}{keys}"))
        );
        println!("  {} {id}", style.dim("id"));
        if commit {
            println!("  {} {message}", style.dim("committed"));
        }
        // Only when there is something to say: a vault created with its
        // keys is ready, and a hint to add one would be wrong.
        if encrypted && accepted.is_empty() {
            println!();
            println!("  It has no recipients yet, so nothing can be written to it:");
            println!();
            println!("      fjord key add <public-key> --vault {name}");
            println!("  or create it with its keys: --recipient <public-key>");
        }
    }

    Ok(ExitCode::Ok)
}

/// What the planner's refusal is called on the command line: the flags the person typed, not the names the web client's form gives them.
fn refusal_message(refusal: &scaffold::VaultError, name: &str) -> String {
    use scaffold::VaultError::*;
    match refusal {
        RecipientsNeedEncryption => "--recipient needs --encrypted: a plaintext vault has no recipients, so the key would be dropped and the vault left readable by everyone".to_string(),
        IdNamingNeedsEncryption => "--id-naming needs --encrypted: naming files by id on a plaintext vault hides nothing and makes the vault unbrowsable, which spec §7.2 requires clients to reject".to_string(),
        BadRecipient { recipient, reason } => format!("{recipient}: {reason}. Nothing was created"),
        NameTaken(_) => format!("{name} already exists"),
        InvalidName { reason, .. } => format!("{name:?} cannot be used as a name: {reason}"),
        other => other.to_string(),
    }
}

fn list(global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    let vaults = vault::discover(&root).context("could not read the repository's vaults")?;

    if global.json {
        let rows: Vec<serde_json::Value> = vaults
            .iter()
            .map(|vault| {
                serde_json::json!({
                    "path": vault.directory,
                    "name": vault.label(),
                    "encrypted": vault.is_encrypted(),
                    "fileNaming": vault.file_naming(),
                    "container": if store::uses_container(vault) { "tar" } else { "none" },
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".to_string())
        );
        return Ok(ExitCode::Ok);
    }

    let style = Style::detect();
    if vaults.is_empty() {
        println!("  no vaults");
        return Ok(ExitCode::Ok);
    }
    for vault in &vaults {
        let mut parts = vec![if vault.is_encrypted() {
            "encrypted".to_string()
        } else {
            "plaintext".to_string()
        }];
        if store::names_by_id(vault) {
            parts.push("named by id".to_string());
        }
        if vault.is_encrypted() {
            let recipients = vault.read_recipients().unwrap_or_default();
            let count = fjord_core::manifest::parse_recipients(&recipients).len();
            parts.push(plural(count, "recipient", "recipients"));
        }
        println!("  {:<12}{}", vault.directory, style.dim(&parts.join(" · ")));
    }
    Ok(ExitCode::Ok)
}

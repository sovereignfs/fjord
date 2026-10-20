// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord vault` — create and list vaults. Spec §2.3, §7.2.

use crate::cli::{ExitCode, GlobalArgs, VaultCommand};
use crate::cmd::{ensure_writable, find_root, plural, usage, Style};
use crate::git::Git;
use anyhow::{Context, Result};
use fjord_core::{crypto, manifest::Manifest, path as rules, scaffold, scalar, store, vault};

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

    // A plaintext vault has no recipients file, so accepting a key would
    // quietly do nothing — and the user would believe it was protected.
    if !recipients.is_empty() && !encrypted {
        return Ok(usage(
            "--recipient needs --encrypted: a plaintext vault has no recipients, so the \
             key would be dropped and the vault left readable by everyone",
        ));
    }

    // Every key is checked before anything is written. A vault created with
    // some of its keys is the worst result: it looks usable, and the keys
    // that are missing are the ones that fail later, on someone else's
    // machine.
    let mut accepted: Vec<String> = Vec::new();
    for recipient in recipients {
        if let Err(reason) = crypto::check_recipient(recipient) {
            return Ok(usage(format!(
                "{}: {reason}. Nothing was created",
                crypto::display_safe(recipient)
            )));
        }
        // The same key twice is harmless to age and pointless to store.
        let recipient = recipient.trim().to_string();
        if !accepted.contains(&recipient) {
            accepted.push(recipient);
        }
    }

    // §7.2: identifier names on a plaintext vault conceal nothing and
    // destroy browsability, and clients MUST reject the combination.
    if id_naming && !encrypted {
        return Ok(usage(
            "--id-naming needs --encrypted: naming files by id on a plaintext vault \
             hides nothing and makes the vault unbrowsable, which spec §7.2 requires \
             clients to reject",
        ));
    }

    // A vault is a directory at the repository root (§2.3), so its name is
    // one path component and the §5 rules apply to it.
    if name.contains('/') || name.contains('\\') {
        return Ok(usage(format!(
            "{name:?} is not a vault name: a vault is a single directory at the \
             repository root (spec §2.3)"
        )));
    }
    if let Some(code) = rules::check_component(name).first() {
        return Ok(usage(format!(
            "{name:?} cannot be used as a name: {} ({})",
            code.message(),
            code.as_str()
        )));
    }

    let directory = root.join(name);
    if directory.exists() {
        return Ok(usage(format!("{name} already exists")));
    }

    let id = scalar::new_ulid();
    let created_at = scalar::now_rfc3339_utc();
    let file_naming = if id_naming { "id" } else { "plain" };
    let files = scaffold::vault_files(name, &id, &created_at, encrypted, file_naming, &accepted);

    // The manifest is rewritten first: a vault on disk that `fjord.json`
    // does not list is only a warning (W601), while a manifest listing a
    // vault that was never created is an error (E106).
    let manifest_path = root.join(fjord_core::REPOSITORY_MANIFEST);
    let manifest =
        Manifest::parse(&std::fs::read(&manifest_path).context("could not read fjord.json")?)
            .map_err(|err| anyhow::anyhow!("fjord.json is not usable: {err}"))?;
    let rewritten = scaffold::with_vault_entry(&manifest, name, &id)
        .context("could not add the vault to fjord.json")?;

    std::fs::create_dir(&directory)
        .with_context(|| format!("could not create {}", directory.display()))?;
    for file in &files {
        std::fs::write(directory.join(&file.path), &file.contents)
            .with_context(|| format!("could not write {name}/{}", file.path))?;
    }
    std::fs::write(&manifest_path, rewritten).context("could not write fjord.json")?;

    // Only the vault and the manifest entry that lists it. See
    // `Git::commit_paths`: a bare commit would take everything staged.
    let message = format!("Add vault {name}");
    if commit {
        repository
            .add_paths(&[name, fjord_core::REPOSITORY_MANIFEST])
            .and_then(|()| {
                repository.commit_paths(&message, &[name, fjord_core::REPOSITORY_MANIFEST])
            })
            // The vault exists by now, and the user needs to know that: the
            // obvious next move is to run this again, and be told it exists.
            .with_context(|| {
                format!(
                    "the {name} vault was created, but could not be committed. Fix the \
                     problem below, then commit it yourself with `git add {name} \
                     fjord.json && git commit`"
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
            "files": files
                .iter()
                .map(|file| format!("{name}/{}", file.path))
                .collect::<Vec<String>>(),
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

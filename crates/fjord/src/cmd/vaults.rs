// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord vault` — create and list vaults. Spec §2.3, §7.2.

use crate::cli::{ExitCode, GlobalArgs, VaultCommand};
use crate::cmd::{ensure_writable, find_root, plural, usage, Style};
use anyhow::{Context, Result};
use fjord_core::{manifest::Manifest, path as rules, scaffold, scalar, store, vault};

pub fn run(command: &VaultCommand, global: &GlobalArgs) -> Result<ExitCode> {
    match command {
        VaultCommand::Add {
            name,
            encrypted,
            id_naming,
        } => add(name, *encrypted, *id_naming, global),
        VaultCommand::List => list(global),
    }
}

fn add(name: &str, encrypted: bool, id_naming: bool, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
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
    let files = scaffold::vault_files(name, &id, &created_at, encrypted, file_naming);

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

    if !global.quiet {
        let style = Style::detect();
        let shape = match (encrypted, id_naming) {
            (false, _) => "plaintext".to_string(),
            (true, false) => "encrypted".to_string(),
            (true, true) => "encrypted, named by id".to_string(),
        };
        println!("  {} {name}  {}", style.good("created"), style.dim(&shape));
        println!("  {} {id}", style.dim("id"));
        if encrypted {
            println!();
            println!("  It has no recipients yet, so nothing can be written to it:");
            println!();
            println!("      fjord key add <public-key> --vault {name}");
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

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord key` — identities and recipients. Spec §6.2, §11.3, §11.4.
//!
//! Three things this command is careful about, all of them from §11:
//!
//! - An identity is **never** written inside a Fjord repository (§11.3), and
//!   never printed. Only its public key is shown.
//! - Adding a recipient does not grant access to anything already written:
//!   age encrypts to the recipients present at write time (§6.2).
//! - Removing a recipient **revokes nothing** (§11.4), and the command must
//!   say so plainly rather than implying otherwise. That is a MUST, and the
//!   wording is tested.

use crate::cli::{ExitCode, GlobalArgs, KeyCommand};
use crate::cmd::{default_identity_path, enclosing_repository, find_root, plural, usage, Style};
use anyhow::{Context, Result};
use fjord_core::crypto;
use fjord_core::manifest::{self, RecipientKind};
use fjord_core::vault;
use std::io::Write;
use std::path::Path;

pub fn run(command: &KeyCommand, global: &GlobalArgs) -> Result<ExitCode> {
    match command {
        KeyCommand::New { out } => new(out.as_deref(), global),
        KeyCommand::Add { recipient, vault } => add(recipient, vault, global),
        KeyCommand::List { vault } => list(vault.as_deref(), global),
        KeyCommand::Remove { recipient, vault } => remove(recipient, vault, global),
    }
}

// --- key new -------------------------------------------------------------

fn new(out: Option<&Path>, global: &GlobalArgs) -> Result<ExitCode> {
    let path = match out {
        Some(path) => path.to_path_buf(),
        None => default_identity_path()?,
    };

    // §11.3: an identity MUST NOT be stored in the repository it decrypts.
    // Refusing any Fjord repository is the safe superset, and it is the
    // mistake most likely to be made once and never noticed.
    if let Some(repository) = enclosing_repository(&path) {
        return Ok(usage(format!(
            "{} is inside the Fjord repository at {}. An identity must never be stored \
             in a repository it decrypts (spec §11.3) — keep it somewhere like {}",
            path.display(),
            repository.display(),
            default_identity_path()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "~/.config/fjord/identity.txt".to_string())
        )));
    }

    if path.exists() {
        return Ok(usage(format!(
            "{} already exists. Generating over an identity would make every file \
             encrypted to it unreadable — delete it yourself if that is really what \
             you want",
            path.display()
        )));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }

    let identity = crypto::generate_identity();
    let contents =
        crypto::identity_file_contents(&identity, &fjord_core::scalar::now_rfc3339_utc());
    write_private(&path, contents.as_bytes())
        .with_context(|| format!("could not write {}", path.display()))?;

    let style = Style::detect();
    if global.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "path": path.display().to_string(),
                "recipient": identity.recipient,
            }))
            .unwrap_or_else(|_| "{}".to_string())
        );
    } else if !global.quiet {
        // The secret itself is never printed: a terminal is scrollback, a
        // CI log, and sometimes a screen share. It is in the file, which the
        // user owns.
        println!("  {} {}", style.good("identity"), path.display());
        println!("  {} {}", style.dim("public key"), identity.recipient);
        println!();
        println!("  Register it as a recipient of a vault:");
        println!();
        println!("      fjord key add {} --vault Private", identity.recipient);
        println!();
        println!(
            "  {}",
            style.dim("Back up the identity file. There is no recovery service.")
        );
    }

    Ok(ExitCode::Ok)
}

/// Write a file only the owner can read.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

// --- key add -------------------------------------------------------------

fn add(recipient: &str, vault_name: &str, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    let vault = match resolve(&root, vault_name)? {
        Ok(vault) => vault,
        Err(code) => return Ok(code),
    };

    // Validated before it is written: a recipients file that `fjord verify`
    // would reject is not an improvement on one with a key missing.
    match manifest::classify_recipient(recipient) {
        Some(RecipientKind::X25519) | Some(RecipientKind::Ssh) => {}
        Some(RecipientKind::Passphrase) => {
            return Ok(usage(
                "a passphrase recipient is not permitted in a vault (spec §6.2): age \
                 refuses to combine one with any other recipient, and a \
                 passphrase-encrypted vault is a different threat model",
            ))
        }
        Some(RecipientKind::Malformed) | None => {
            return Ok(usage(format!(
                "{recipient} is not an age recipient. Expected an `age1…` public key, \
                 or an `ssh-ed25519`/`ssh-rsa` line"
            )))
        }
    }

    let path = match vault.recipients_file() {
        Some(path) => path,
        None => {
            return Ok(usage(format!(
                "the {} vault declares no usable recipients file",
                vault.directory
            )))
        }
    };

    let existing = vault
        .read_recipients()
        .context("could not read the recipients file")?;
    if manifest::parse_recipients(&existing)
        .iter()
        .any(|line| line.text == recipient)
    {
        if !global.quiet {
            println!("  already a recipient of {}", vault.directory);
        }
        return Ok(ExitCode::Ok);
    }

    let mut updated = existing.clone();
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(recipient);
    updated.push('\n');
    std::fs::write(&path, &updated)
        .with_context(|| format!("could not write {}", path.display()))?;

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {recipient} to {}",
            style.good("added"),
            vault.directory
        );
        println!();
        // §6.2, and the single most common misunderstanding about age.
        println!("  This does not grant access to anything already written: age encrypts");
        println!("  each file to the recipients present at the time. Run `fjord rekey` if");
        println!("  this key must read existing documents.");
    }

    Ok(ExitCode::Ok)
}

// --- key list ------------------------------------------------------------

fn list(vault_name: Option<&str>, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;

    let vaults = match vault_name {
        Some(name) => match resolve(&root, name)? {
            Ok(vault) => vec![vault],
            Err(code) => return Ok(code),
        },
        None => vault::discover(&root).context("could not read the repository's vaults")?,
    };

    let mut rows = Vec::new();
    for vault in &vaults {
        if !vault.is_encrypted() {
            continue;
        }
        let text = vault
            .read_recipients()
            .context("could not read a recipients file")?;
        let recipients: Vec<String> = manifest::parse_recipients(&text)
            .into_iter()
            .filter(|line| matches!(line.kind, RecipientKind::X25519 | RecipientKind::Ssh))
            .map(|line| line.text)
            .collect();
        rows.push((vault.directory.clone(), recipients));
    }

    if global.json {
        let document: Vec<serde_json::Value> = rows
            .iter()
            .map(|(vault, recipients)| {
                serde_json::json!({ "vault": vault, "recipients": recipients })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&document).unwrap_or_else(|_| "[]".to_string())
        );
        return Ok(ExitCode::Ok);
    }

    if global.quiet {
        for (_, recipients) in &rows {
            for recipient in recipients {
                println!("{recipient}");
            }
        }
        return Ok(ExitCode::Ok);
    }

    let style = Style::detect();
    if rows.is_empty() {
        println!("  no encrypted vaults");
        return Ok(ExitCode::Ok);
    }
    for (vault, recipients) in &rows {
        println!(
            "  {vault}  {}",
            style.dim(&plural(recipients.len(), "recipient", "recipients"))
        );
        for recipient in recipients {
            println!("    {recipient}");
        }
        if recipients.is_empty() {
            println!(
                "    {}",
                style.dim("none, so nothing can be written to this vault")
            );
        }
    }

    Ok(ExitCode::Ok)
}

// --- key remove ----------------------------------------------------------

fn remove(recipient: &str, vault_name: &str, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    let vault = match resolve(&root, vault_name)? {
        Ok(vault) => vault,
        Err(code) => return Ok(code),
    };

    let path = match vault.recipients_file() {
        Some(path) => path,
        None => {
            return Ok(usage(format!(
                "the {} vault declares no usable recipients file",
                vault.directory
            )))
        }
    };

    let existing = vault
        .read_recipients()
        .context("could not read the recipients file")?;
    let kept: Vec<&str> = existing
        .lines()
        .filter(|line| line.trim() != recipient)
        .collect();

    if kept.len() == existing.lines().count() {
        return Ok(usage(format!(
            "{recipient} is not a recipient of {}",
            vault.directory
        )));
    }

    let mut updated = kept.join("\n");
    if !updated.is_empty() {
        updated.push('\n');
    }
    std::fs::write(&path, &updated)
        .with_context(|| format!("could not write {}", path.display()))?;

    let remaining = manifest::parse_recipients(&updated)
        .into_iter()
        .filter(|line| matches!(line.kind, RecipientKind::X25519 | RecipientKind::Ssh))
        .count();

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {recipient} from {}",
            style.good("removed"),
            vault.directory
        );
        println!();
        // Spec §11.4 is a MUST: state plainly that this is not revocation.
        println!("  {}", style.warning("This revokes nothing."));
        println!("  Every version already committed stays decryptable by that key,");
        println!("  permanently, because Git keeps history. Removing a recipient affects");
        println!("  only files written from now on.");
        println!();
        println!("  Genuinely retiring a compromised key means re-encrypting every file");
        println!("  and rewriting history — in practice, a new repository.");

        if remaining == 0 {
            println!();
            println!(
                "  {}",
                style.warning(&format!(
                    "{} now has no recipients, so nothing can be written to it.",
                    vault.directory
                ))
            );
        }
    }

    Ok(ExitCode::Ok)
}

// --- Shared --------------------------------------------------------------

/// Find an encrypted vault by name, or the usage error explaining why not.
fn resolve(root: &Path, name: &str) -> Result<std::result::Result<vault::Vault, ExitCode>> {
    let found = vault::find(root, name).context("could not read the repository's vaults")?;
    let vault = match found {
        Some(vault) => vault,
        None => {
            return Ok(Err(usage(format!(
                "no vault called {name}. `fjord verify` lists what is there"
            ))))
        }
    };
    if !vault.is_encrypted() {
        return Ok(Err(usage(format!(
            "the {} vault is not encrypted, so it has no recipients",
            vault.directory
        ))));
    }
    Ok(Ok(vault))
}

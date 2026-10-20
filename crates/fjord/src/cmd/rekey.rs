// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord rekey` — re-encrypt a vault to its current recipients. Spec §6.2.
//!
//! age encrypts each file to the recipients present when it was written, so
//! adding a key grants no access to anything already stored (§6.2). This is
//! the command that closes that gap, and `fjord key add` says so.
//!
//! # What it refuses to do
//!
//! **Lock you out of your own vault.** Re-encrypting to a recipient list
//! that does not include an identity you hold would make every document in
//! it permanently unreadable — and §11.4 is clear that nothing can be
//! undone afterwards. So one document is re-encrypted and read back before
//! anything is written, and a result we cannot read is a refusal rather
//! than a warning.
//!
//! # What it cannot do
//!
//! Revoke anything. Every version already committed stays decryptable by
//! every key it was written to, permanently, because Git keeps history
//! (§11.4). Rekeying changes what happens from now on.

use crate::cli::{ExitCode, GlobalArgs, RekeyArgs};
use crate::cmd::{ensure_writable, find_root, load_identities, plural, usage, Style};
use crate::git::Git;
use anyhow::{Context, Result};
use fjord_core::crypto::{Identities, Recipients};
use fjord_core::vault::{self, Content, Vault};
use fjord_core::{crypto, store};
use std::io::{BufRead, IsTerminal, Write};

pub fn run(args: &RekeyArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }

    let vault =
        match vault::find(&root, &args.vault).context("could not read the repository's vaults")? {
            Some(vault) => vault,
            None => {
                return Ok(usage(format!(
                    "no vault called {}. `fjord vault list` shows what is there",
                    args.vault
                )))
            }
        };
    if !vault.is_encrypted() {
        return Ok(usage(format!(
            "the {} vault is not encrypted, so there is nothing to re-encrypt",
            vault.directory
        )));
    }

    let recipients = crypto::parse_recipients(
        &vault
            .read_recipients()
            .context("could not read the recipients file")?,
    )
    .with_context(|| {
        format!(
            "the {} vault's recipients file is not usable",
            vault.directory
        )
    })?;
    if recipients.is_empty() {
        return Ok(usage(format!(
            "the {} vault has no recipients, so nothing could be written to it. \
             Add one with `fjord key add`",
            vault.directory
        )));
    }

    let identities = load_identities(global)?;

    let payloads: Vec<Content> = vault
        .contents()
        .with_context(|| format!("could not read the {} vault", vault.directory))?
        .into_iter()
        .filter(|content| content.is_payload)
        .collect();

    // A file in the clear is `fjord encrypt`'s business, not this
    // command's: encrypting it here would change its name on disk, which
    // is not what "re-encrypt the vault" means.
    let in_the_clear = vault
        .contents()
        .map(|contents| contents.iter().filter(|c| !c.is_payload).count())
        .unwrap_or(0);

    let style = Style::detect();
    if payloads.is_empty() {
        if !global.quiet {
            println!("  {}", style.dim("nothing to re-encrypt"));
        }
        return Ok(ExitCode::Ok);
    }

    // Before anything is written: prove the new recipient list produces
    // something we can still read.
    if let Some(code) = check_not_locking_out(&vault, &recipients, &identities)? {
        return Ok(code);
    }

    if !confirm(args, global, &vault, payloads.len(), recipients.len())? {
        if !global.quiet {
            println!("  {}", style.dim("left alone"));
        }
        return Ok(ExitCode::Ok);
    }

    let mut rewritten = 0usize;
    for content in &payloads {
        rekey_one(&vault, content, &recipients, &identities).with_context(|| {
            format!(
                "could not re-encrypt {}/{} — {rewritten} of {} were already rewritten, \
                 and every one of them is still readable",
                vault.directory,
                content.relative,
                payloads.len()
            )
        })?;
        rewritten += 1;
    }

    // One commit, as the README promises: age output is non-deterministic,
    // so every file in the vault has changed, and a commit per document
    // would bury the history of every other change in the repository.
    let repository = Git::new(&root);
    let committed = if repository.is_repository() {
        repository.add_path(&vault.directory)?;
        // Only this vault: see `Git::commit_paths`.
        repository.commit_paths(
            &format!(
                "Rekey {} to {}",
                vault.directory,
                plural(recipients.len(), "recipient", "recipients")
            ),
            &[&vault.directory],
        )?;
        true
    } else {
        false
    };

    if !global.quiet {
        println!(
            "  {} {} in {} to {}",
            style.good("re-encrypted"),
            plural(rewritten, "document", "documents"),
            vault.directory,
            plural(recipients.len(), "recipient", "recipients")
        );
        if committed {
            println!("  {}", style.dim("committed as one commit"));
        }
        if in_the_clear > 0 {
            println!();
            println!(
                "  {} {} in this vault {} not encrypted and {} left alone. \
                 `fjord verify` reports them as E201.",
                style.warning("note:"),
                plural(in_the_clear, "file", "files"),
                if in_the_clear == 1 { "is" } else { "are" },
                if in_the_clear == 1 { "was" } else { "were" }
            );
        }
        println!();
        // §11.4 is a MUST wherever a user might infer revocation, and
        // "re-encrypted to the current list" is exactly such a place.
        println!("  {}", style.warning("This revokes nothing."));
        println!("  Every version already committed stays decryptable by every key it was");
        println!("  written to, permanently, because Git keeps history. Rekeying changes");
        println!("  what happens from here.");
    }

    Ok(ExitCode::Ok)
}

/// Re-encrypt one payload in place.
///
/// The name on disk does not change: a `plain` vault keeps the document's
/// name and an `id` vault keeps its identifier (§7.2). Written through a
/// temporary file in the same directory, so an interrupted write cannot
/// leave a truncated payload where a readable one used to be.
fn rekey_one(
    vault: &Vault,
    content: &Content,
    recipients: &Recipients,
    identities: &Identities,
) -> Result<()> {
    let path = vault.path.join(&content.relative);
    let stored =
        std::fs::read(&path).with_context(|| format!("could not read {}", content.relative))?;

    let loaded = store::load(vault, &stored, Some(identities))
        .with_context(|| format!("could not decrypt {}", content.relative))?;

    // The container carries the real name; without one, the name is the
    // file's own, suffix removed.
    let name = match &loaded.name {
        Some(name) => name.clone(),
        None => content
            .logical
            .rsplit('/')
            .next()
            .unwrap_or(&content.logical)
            .to_string(),
    };

    let fresh = store::store(vault, &name, &loaded.plaintext, Some(recipients))
        .with_context(|| format!("could not re-encrypt {}", content.relative))?;

    let directory = path.parent().unwrap_or(&vault.path);
    let mut temporary = tempfile::Builder::new()
        .prefix(".fjord-rekey-")
        .suffix(".age.tmp")
        .tempfile_in(directory)
        .with_context(|| format!("could not stage {}", content.relative))?;
    temporary
        .write_all(&fresh)
        .with_context(|| format!("could not write {}", content.relative))?;
    temporary
        .as_file()
        .sync_all()
        .with_context(|| format!("could not flush {}", content.relative))?;
    temporary
        .persist(&path)
        .with_context(|| format!("could not replace {}", content.relative))?;

    Ok(())
}

/// Refuse to produce a vault we could not then read.
///
/// One document is re-encrypted to the new list and read back. If that
/// fails, the identity in use is not among the recipients, and rekeying
/// would make every document permanently unreadable — §11.4 leaves no way
/// back from that.
fn check_not_locking_out(
    vault: &Vault,
    recipients: &Recipients,
    identities: &Identities,
) -> Result<Option<ExitCode>> {
    let probe = store::store(vault, "probe.md", b"probe", Some(recipients))
        .context("could not encrypt to the current recipient list")?;

    match store::load(vault, &probe, Some(identities)) {
        Ok(loaded) if &loaded.plaintext[..] == b"probe" => Ok(None),
        _ => Ok(Some(usage(format!(
            "none of your identities is in {}'s recipient list, so re-encrypting would \
             make every document in it permanently unreadable — and spec §11.4 leaves no \
             way back. Add your public key with `fjord key add` first, or use `age -R` \
             directly if handing the vault to someone else is really the intent",
            vault.directory
        )))),
    }
}

/// Ask before rewriting a whole vault.
fn confirm(
    args: &RekeyArgs,
    global: &GlobalArgs,
    vault: &Vault,
    documents: usize,
    recipients: usize,
) -> Result<bool> {
    if args.yes {
        return Ok(true);
    }
    if global.no_input {
        // CLAUDE.md: with `--no-input` a required prompt is a usage error,
        // never a hang.
        anyhow::bail!(
            "rewriting a whole vault needs confirmation. Pass --yes to say so without \
             being asked"
        );
    }
    if !std::io::stdin().is_terminal() {
        anyhow::bail!(
            "rewriting a whole vault needs confirmation, and there is no terminal to \
             ask on. Pass --yes"
        );
    }

    let mut stdin = std::io::stdin().lock();
    let mut stderr = std::io::stderr();
    ask(
        &mut stdin,
        &mut stderr,
        &vault.directory,
        documents,
        recipients,
    )
}

/// The prompt, over a reader and a writer so the interactive path is
/// testable without a pseudo-terminal.
pub fn ask(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    vault: &str,
    documents: usize,
    recipients: usize,
) -> Result<bool> {
    writeln!(
        writer,
        "Re-encrypt {} in {vault} to {}?",
        plural(documents, "document", "documents"),
        plural(recipients, "recipient", "recipients")
    )?;
    writeln!(
        writer,
        "Every file in the vault will be rewritten, in one commit."
    )?;
    write!(writer, "Continue? [y/N]: ")?;
    writer.flush()?;

    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        // End of input: the cautious answer.
        return Ok(false);
    }
    Ok(matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn answer(input: &str) -> (bool, String) {
        let mut reader = Cursor::new(input.as_bytes().to_vec());
        let mut written = Vec::new();
        let agreed = ask(&mut reader, &mut written, "Private", 12, 2).expect("ask");
        (agreed, String::from_utf8_lossy(&written).to_string())
    }

    #[test]
    fn the_prompt_says_what_will_happen() {
        let (_, prompt) = answer("n\n");
        assert!(prompt.contains("12 documents"), "{prompt}");
        assert!(prompt.contains("Private"), "{prompt}");
        assert!(prompt.contains("2 recipients"), "{prompt}");
        assert!(prompt.contains("one commit"), "{prompt}");
    }

    #[test]
    fn only_yes_means_yes() {
        for input in ["y\n", "Y\n", "yes\n", "YES\n"] {
            assert!(answer(input).0, "{input:?} should agree");
        }
        // Anything else leaves the vault alone: the default for a
        // destructive, irreversible rewrite is no.
        for input in ["n\n", "\n", "maybe\n", "", "sure\n"] {
            assert!(!answer(input).0, "{input:?} should decline");
        }
    }
}

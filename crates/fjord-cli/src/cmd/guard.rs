// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The commit guard. Spec §6.5.
//!
//! Spec §6.5 says a client MUST NOT commit an unencrypted document into an
//! encrypted vault, and relies on the vault's own `.gitignore` to make the
//! common accident fail safe. That guard is a safety net and not a lock:
//! with it intact, a stray plaintext file is silently *skipped* by a commit
//! (the edit is simply not saved, and nothing says so), and with it missing
//! the file is committed and pushed.
//!
//! So every command that stages and commits on its own authority asks this
//! first, and refuses instead of finding out afterwards:
//!
//! - `fjord sync` stages the whole working tree;
//! - `fjord rekey` and `fjord vault add --commit` stage a whole vault
//!   directory.
//!
//! The question is the one `fjord verify` already answers — E201 (a file in
//! the clear inside an encrypted vault) and E208 (the guard `.gitignore` is
//! missing) — so the detection is `verify`'s, not a second implementation
//! that could drift from it.

use crate::cli::ExitCode;
use anyhow::{Context, Result};
use fjord_core::diagnostics::Code;
use fjord_core::vault;
use fjord_core::verify::{self, Options};
use std::path::Path;

/// How many files to name before summarising.
const NAMED: usize = 8;

/// What `verify` finds in one encrypted vault that makes a commit unsafe.
#[derive(Debug, Default)]
pub struct Findings {
    /// Files in the clear (E201), vault-relative to the repository root.
    pub in_the_clear: Vec<String>,
    /// The vault's plaintext-guard `.gitignore` is missing or wrong (E208).
    pub unguarded: bool,
}

/// Ask `verify` about one vault.
pub fn inspect(root: &Path, vault: &str) -> Result<Findings> {
    let report = verify::verify(
        root,
        &Options {
            vault: Some(vault.to_string()),
        },
    )
    .with_context(|| format!("could not check the {vault} vault"))?;

    let mut findings = Findings::default();
    for diagnostic in &report.diagnostics {
        match diagnostic.code {
            Code::PlaintextGuardMissing => findings.unguarded = true,
            Code::PlaintextInEncryptedVault => {
                if let Some(path) = &diagnostic.path {
                    findings.in_the_clear.push(path.clone());
                }
            }
            _ => {}
        }
    }
    Ok(findings)
}

/// Refuse when an encrypted vault is checked out, holds anything in the
/// clear, or lacks the `.gitignore` that keeps it out of a commit.
///
/// Returns `Some(code)` after printing why, and `None` when it is safe to
/// go on. Read-only: nothing is moved, encrypted or deleted, because which
/// of those the user wants is theirs to say.
pub fn ensure_nothing_in_the_clear(root: &Path) -> Result<Option<ExitCode>> {
    let checked_out = crate::cmd::checkout::all(root)?;
    let mut unguarded = Vec::new();
    let mut in_the_clear = Vec::new();

    for vault in vault::discover(root).context("could not read the repository's vaults")? {
        if !vault.is_encrypted() {
            continue;
        }
        let findings = inspect(root, &vault.directory)?;
        if findings.unguarded {
            unguarded.push(vault.directory.clone());
        }
        // A checked-out vault is *expected* to hold files in the clear, and
        // is reported once, as what it is, rather than file by file.
        if !checked_out
            .iter()
            .any(|record| record.vault == vault.directory)
        {
            in_the_clear.extend(findings.in_the_clear);
        }
    }

    if checked_out.is_empty() && unguarded.is_empty() && in_the_clear.is_empty() {
        return Ok(None);
    }

    eprintln!("error: refusing to commit, because an encrypted vault is not safe to commit.");
    for record in &checked_out {
        eprintln!();
        eprintln!(
            "  The {} vault is checked out: {} decrypted in place (spec §6.6).",
            record.vault,
            count(record.entries.len(), "document is", "documents are")
        );
        eprintln!(
            "  Check it back in with `fjord encrypt {0}`, or throw the decrypted copies away \
             with `fjord encrypt {0} --discard`. Nothing was committed.",
            record.vault
        );
    }
    if !in_the_clear.is_empty() {
        eprintln!();
        eprintln!(
            "  {} in the clear inside an encrypted vault (E201):",
            count(in_the_clear.len(), "file is", "files are")
        );
        for path in in_the_clear.iter().take(NAMED) {
            eprintln!("    {path}");
        }
        if in_the_clear.len() > NAMED {
            eprintln!("    … and {} more", in_the_clear.len() - NAMED);
        }
        eprintln!();
        eprintln!(
            "  Encrypt each with `fjord encrypt <path>` (or `fjord open` to edit one), or move \
             it out of the repository. Nothing was committed, and these edits are not saved \
             until you do."
        );
    }
    if !unguarded.is_empty() {
        eprintln!();
        unguarded.sort();
        unguarded.dedup();
        eprintln!(
            "  {} no plaintext-guard .gitignore (E208), so a decrypted file there would be \
             committed rather than skipped:",
            count(unguarded.len(), "vault has", "vaults have")
        );
        for vault in &unguarded {
            eprintln!("    {vault}");
        }
        eprintln!();
        eprintln!(
            "  Restore it from a clean checkout (`git checkout -- <vault>/.gitignore`), or \
             copy it from a vault that has one."
        );
    }

    Ok(Some(ExitCode::Problems))
}

fn count(n: usize, singular: &str, plural: &str) -> String {
    format!("{n} {}", if n == 1 { singular } else { plural })
}

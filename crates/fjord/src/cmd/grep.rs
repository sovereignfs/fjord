//! `fjord grep` — search document contents. Spec §6.
//!
//! In an encrypted vault this decrypts every file in scope to search it,
//! which is slower than `grep` on plaintext and unavoidable: that is what
//! encryption costs. Decrypted content is held in [`Zeroizing`] buffers and
//! never written anywhere.
//!
//! The pattern is a **literal substring**, not a regular expression. A
//! regex engine is not among the dependencies this project has chosen, and
//! promising regex syntax while implementing substring matching would be
//! worse than saying plainly which one it is.

use crate::cli::{ExitCode, GlobalArgs, GrepArgs};
use crate::cmd::{find_root, read_document, usage, DocumentRead, Style};
use anyhow::{Context, Result};
use fjord_core::vault;

/// One matching line.
#[derive(Debug)]
struct Match {
    path: String,
    line: usize,
    text: String,
}

pub fn run(args: &GrepArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;

    let scope = match args.path.as_deref() {
        Some(path) => match crate::cmd::repo_relative(&root, path)? {
            Ok(relative) => relative,
            Err(message) => return Ok(usage(message)),
        },
        None => String::new(),
    };

    // Encrypted vaults need an identity; plaintext ones do not. A missing
    // identity is therefore not fatal — it narrows the search, and the
    // command says by how much.
    let identities = crate::cmd::load_identities(global).ok();

    let needle = if args.ignore_case {
        args.pattern.to_lowercase()
    } else {
        args.pattern.clone()
    };

    let mut matches = Vec::new();
    let mut skipped = Vec::new();
    let mut searched = 0usize;

    for vault in vault::discover(&root).context("could not read the repository's vaults")? {
        if vault.is_encrypted() && identities.is_none() {
            skipped.push(vault.directory.clone());
            continue;
        }

        let contents = vault
            .contents()
            .with_context(|| format!("could not read the {} vault", vault.directory))?;

        for content in contents {
            let stored_path = format!("{}/{}", vault.directory, content.logical);
            if !scope.is_empty()
                && stored_path != scope
                && !stored_path.starts_with(&format!("{scope}/"))
            {
                continue;
            }

            let on_disk = vault.path.join(&content.relative);
            let (name, bytes) = match read_document(&vault, &on_disk, identities.as_ref()) {
                DocumentRead::Text { name, bytes } => (name, bytes),
                DocumentRead::NeedsIdentity => {
                    skipped.push(stored_path);
                    continue;
                }
                // A different problem entirely — a permission, a vanished
                // file — and worth saying which.
                DocumentRead::Failed(reason) => {
                    skipped.push(format!("{stored_path} ({reason})"));
                    continue;
                }
            };

            // In an `id` vault the stored path is a ULID, which tells a
            // reader nothing. The container knows the document's real
            // name, so that is what a search result shows.
            let path = match &name {
                Some(name) => match stored_path.rsplit_once('/') {
                    Some((directory, _)) => format!("{directory}/{name}"),
                    None => name.clone(),
                },
                None => stored_path,
            };

            // Binary files have no lines to show. Skipping them silently is
            // what `grep` does without `-a`, and a vault legitimately holds
            // PDFs and spreadsheets.
            let text = match std::str::from_utf8(&bytes) {
                Ok(text) => text,
                Err(_) => continue,
            };
            searched += 1;

            for (index, line) in text.lines().enumerate() {
                let haystack = if args.ignore_case {
                    line.to_lowercase()
                } else {
                    line.to_string()
                };
                if haystack.contains(&needle) {
                    matches.push(Match {
                        path: path.clone(),
                        line: index + 1,
                        text: line.to_string(),
                    });
                }
            }
        }
    }

    matches.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
    skipped.sort();
    skipped.dedup();

    if global.json {
        let document = serde_json::json!({
            "pattern": args.pattern,
            "searched": searched,
            "skipped": skipped,
            "matches": matches
                .iter()
                .map(|found| serde_json::json!({
                    "path": found.path,
                    "line": found.line,
                    "text": found.text,
                }))
                .collect::<Vec<serde_json::Value>>(),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string())
        );
        return Ok(ExitCode::Ok);
    }

    let style = Style::detect();
    for found in &matches {
        println!(
            "{}:{}:{}",
            style.good(&found.path),
            found.line,
            found.text.trim_end()
        );
    }

    if !skipped.is_empty() && !global.quiet {
        eprintln!(
            "note: {} not searched, for want of an identity that decrypts them: {}",
            crate::cmd::plural(skipped.len(), "vault or document", "vaults or documents"),
            skipped.join(", ")
        );
    }

    // Deliberately *not* grep(1)'s convention of exiting 1 on no matches.
    // This toolchain's exit 1 means "problems found in the repository", and
    // an honest search that found nothing is not a problem. The JSON output
    // carries the count for scripts that need it.
    Ok(ExitCode::Ok)
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord export` and `fjord import`. Spec §6, §8.2.
//!
//! `export` is the escape hatch. The README promises it is "deliberately
//! simple and will keep working", which is a design constraint rather than
//! a disclaimer: whatever else changes, decrypting a whole vault into a
//! plain directory has to stay one obvious command. It writes **outside the
//! repository only** — invariant 1 again, and the one place a bulk decrypt
//! could do real damage.
//!
//! `import` is its inverse: a directory of files becomes documents in a
//! vault. Markdown files without frontmatter are promoted to Docs, which
//! §8.2 permits on an explicit instruction ("MAY assign an `id` ... when
//! the user edits it") while forbidding it on a mere scan. Everything else
//! is stored as a vault file, which is what §8 says it is.
//!
//! Both are all-or-nothing about names: every path is checked against §5
//! and against what already exists *before* anything is written, because a
//! bulk operation that stops halfway leaves a mess no error message can
//! describe.

use crate::cli::{ExitCode, ExportArgs, GlobalArgs, ImportArgs};
use crate::cmd::{ensure_writable, find_root, plural, resolve_destination, usage, Style};
use anyhow::{Context, Result};
use fjord_core::vault::{self, Vault};
use fjord_core::{crypto, doc, path as rules, scalar, store};
use std::path::{Path, PathBuf};

// --- export ---------------------------------------------------------------

pub fn export(args: &ExportArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;

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

    let destination = resolve_destination(&args.dir);
    if let Some(problem) = inside_repository(&root, &destination)? {
        return Ok(usage(problem));
    }
    if let Some(problem) = unusable_destination(&destination) {
        return Ok(usage(problem));
    }

    let identities = if vault.is_encrypted() {
        Some(crate::cmd::load_identities(global)?)
    } else {
        None
    };

    let contents = vault
        .contents()
        .with_context(|| format!("could not read the {} vault", vault.directory))?;

    // Decrypted first, written second. A bulk decrypt that fails halfway
    // through should not have left half a vault in the clear on disk.
    let mut documents = Vec::new();
    for content in &contents {
        let stored = std::fs::read(vault.path.join(&content.relative))
            .with_context(|| format!("could not read {}", content.relative))?;
        let loaded = store::load(&vault, &stored, identities.as_ref())
            .with_context(|| format!("could not read {}", content.relative))?;

        // The container knows the real name where there is one; otherwise
        // it is the path with the suffix already stripped.
        let relative = match &loaded.name {
            Some(name) => match content.logical.rsplit_once('/') {
                Some((directory, _)) => format!("{directory}/{name}"),
                None => name.clone(),
            },
            None => content.logical.clone(),
        };

        // §11.5: a container's entry name came from outside. `container`
        // already refuses a path or a `..`, and this is the second check,
        // because the cost of being wrong here is a file written outside
        // the directory the user named.
        if let Some(code) = rules::check_manifest_path(&relative) {
            return Ok(usage(format!(
                "{} would be written to {relative:?}, which is not a safe path ({})",
                content.relative,
                code.as_str()
            )));
        }

        documents.push((relative, loaded.plaintext));
    }

    std::fs::create_dir_all(&destination)
        .with_context(|| format!("could not create {}", destination.display()))?;

    for (relative, plaintext) in &documents {
        let path = destination.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
        std::fs::write(&path, &plaintext[..])
            .with_context(|| format!("could not write {}", path.display()))?;
    }

    if global.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "vault": vault.directory,
                "directory": destination.display().to_string(),
                "files": documents.iter().map(|(r, _)| r).collect::<Vec<&String>>(),
            }))
            .unwrap_or_else(|_| "{}".to_string())
        );
        return Ok(ExitCode::Ok);
    }

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {} from {} to {}",
            style.good("exported"),
            plural(documents.len(), "file", "files"),
            vault.directory,
            destination.display()
        );
        if vault.is_encrypted() && !documents.is_empty() {
            println!();
            println!(
                "  {}",
                style.warning("These are decrypted. Delete them when you are done.")
            );
        }
    }

    Ok(ExitCode::Ok)
}

// --- import ---------------------------------------------------------------

pub fn import(args: &ImportArgs, global: &GlobalArgs) -> Result<ExitCode> {
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

    let source = resolve_destination(&args.dir);
    if !source.is_dir() {
        return Ok(usage(format!("{} is not a directory", args.dir.display())));
    }
    // Importing a vault into itself would read files as it wrote them.
    if inside_repository(&root, &source)?.is_none() {
        // Outside the repository: the ordinary case.
    } else {
        return Ok(usage(format!(
            "{} is inside the repository. `fjord import` brings files in from \
             elsewhere; to move something between vaults, export it first",
            source.display()
        )));
    }

    let recipients = if vault.is_encrypted() {
        let parsed = crypto::parse_recipients(
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
        if parsed.is_empty() {
            return Ok(usage(format!(
                "the {} vault has no recipients, so nothing can be written to it. \
                 Add one with `fjord key add`",
                vault.directory
            )));
        }
        Some(parsed)
    } else {
        None
    };

    let mut found = Vec::new();
    collect(&source, "", &mut found)?;
    found.sort();
    if found.is_empty() {
        if !global.quiet {
            println!("  {}", Style::detect().dim("nothing to import"));
        }
        return Ok(ExitCode::Ok);
    }

    // Every name checked against §5, and every destination checked for a
    // collision, before a single file is written. A half-finished import is
    // worse than a refused one.
    let mut refusals = Vec::new();
    for relative in &found {
        for component in relative.split('/') {
            if let Some(code) = rules::check_component(component).first() {
                refusals.push(format!(
                    "{relative}: {component:?} {} ({})",
                    code.message(),
                    code.as_str()
                ));
                break;
            }
        }
    }
    if !refusals.is_empty() {
        return Ok(usage(format!(
            "{} cannot be stored under the path rules of spec §5, so nothing was \
             imported:\n  {}",
            plural(refusals.len(), "file", "files"),
            refusals.join("\n  ")
        )));
    }

    // Prepare everything, then write. Each document's id is needed before
    // its path is known, because an `id` vault names the file after it
    // (§7.2).
    let created_at = scalar::now_rfc3339_utc();
    let mut planned: Vec<(String, Vec<u8>)> = Vec::new();
    let mut promoted = 0usize;

    for relative in &found {
        let bytes = std::fs::read(source.join(relative))
            .with_context(|| format!("could not read {relative}"))?;
        let leaf = relative.rsplit('/').next().unwrap_or(relative);
        let (contents, was_promoted, id) = prepare(&bytes, leaf, &scalar::new_ulid(), &created_at);
        if was_promoted {
            promoted += 1;
        }

        // `id` is the Doc's own: its frontmatter id if it already had one, a
        // fresh one if it was just given frontmatter, and in an `id` vault
        // it is also the file's name, which §7.2 requires to be the same.
        let on_disk = match on_disk_path(&vault, relative, &id) {
            Ok(path) => path,
            Err(message) => return Ok(usage(message)),
        };
        if root.join(&on_disk).exists() {
            return Ok(usage(format!(
                "{on_disk} already exists, so nothing was imported"
            )));
        }
        // Two files carrying one id would be stored under one name. In a
        // plaintext vault the names are the files' own and cannot collide.
        if planned.iter().any(|(path, _)| path == &on_disk) {
            return Ok(usage(format!(
                "{relative} has an id that another file in this import already has, so \
                 both would be stored as {on_disk} (spec §8.3 makes ids unique). Nothing \
                 was imported"
            )));
        }

        let stored = store::store(&vault, leaf, &contents, recipients.as_ref())
            .with_context(|| format!("could not store {relative}"))?;
        planned.push((on_disk, stored));
    }

    for (on_disk, bytes) in &planned {
        let path = root.join(on_disk);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
        std::fs::write(&path, bytes).with_context(|| format!("could not write {on_disk}"))?;
    }

    if global.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "vault": vault.directory,
                "imported": planned.len(),
                "promoted": promoted,
                "files": planned.iter().map(|(p, _)| p).collect::<Vec<&String>>(),
            }))
            .unwrap_or_else(|_| "{}".to_string())
        );
        return Ok(ExitCode::Ok);
    }

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {} into {}",
            style.good("imported"),
            plural(planned.len(), "file", "files"),
            vault.directory
        );
        if promoted > 0 {
            println!(
                "  {}",
                style.dim(&format!(
                    "{} gained frontmatter and {} now {}",
                    plural(promoted, "file", "files"),
                    if promoted == 1 { "is" } else { "are" },
                    if promoted == 1 { "a Doc" } else { "Docs" }
                ))
            );
        }
        println!(
            "  {}",
            style.dim("nothing was committed; `fjord sync` will")
        );
    }

    Ok(ExitCode::Ok)
}

/// Give a Markdown file the frontmatter of a Doc, and leave everything else
/// as it is. Returns the bytes to store, whether the file was promoted, and
/// the id the document goes by: its own, when it already had one, otherwise
/// `id`.
fn prepare(bytes: &[u8], leaf: &str, id: &str, created_at: &str) -> (Vec<u8>, bool, String) {
    if !leaf.ends_with(".md") {
        // §8: anything that is not Markdown is a vault file, stored and
        // encrypted identically and carrying no Fjord metadata.
        return (bytes.to_vec(), false, id.to_string());
    }
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        // Not text, so there is nowhere to put frontmatter.
        Err(_) => return (bytes.to_vec(), false, id.to_string()),
    };

    // Already a Doc: leave its identity alone. §8.2 makes `id` immutable.
    if let doc::Parse::Present { frontmatter, .. } = doc::parse(text) {
        if let Some(existing) = frontmatter.doc_id() {
            return (bytes.to_vec(), false, existing.to_string());
        }
    }

    let title = doc::implied_title(text, leaf);
    match doc::promote(text, id, created_at, &title) {
        Some(promoted) => (promoted.into_bytes(), true, id.to_string()),
        // A frontmatter block that is present but broken is not ours to
        // rewrite; it comes in as it is and `fjord verify` will say so.
        None => (bytes.to_vec(), false, id.to_string()),
    }
}

/// Where an imported file lands, including the `id` naming of §7.2.
fn on_disk_path(vault: &Vault, relative: &str, id: &str) -> std::result::Result<String, String> {
    let (directory, leaf) = match relative.rsplit_once('/') {
        Some((directory, leaf)) => (Some(directory), leaf),
        None => (None, relative),
    };
    let name = store::on_disk_name(vault, leaf, Some(id))
        .map_err(|err| format!("{relative} cannot be stored in this vault: {err}"))?;
    Ok(match directory {
        Some(directory) => format!("{}/{directory}/{name}", vault.directory),
        None => format!("{}/{name}", vault.directory),
    })
}

// --- Shared ---------------------------------------------------------------

/// Why writing to `path` would put plaintext in the repository, if it
/// would.
fn inside_repository(root: &Path, path: &Path) -> Result<Option<String>> {
    let canonical_root = std::fs::canonicalize(root)
        .with_context(|| format!("could not resolve {}", root.display()))?;
    if path.starts_with(&canonical_root) {
        return Ok(Some(format!(
            "{} is inside the repository at {}. A bulk decrypt belongs outside it: \
             anything in a vault is committed, and anything in an encrypted vault must \
             never be plaintext (spec §6.5)",
            path.display(),
            canonical_root.display()
        )));
    }
    Ok(None)
}

/// Why `destination` cannot be exported into, if it cannot.
fn unusable_destination(destination: &Path) -> Option<String> {
    if !destination.exists() {
        return None;
    }
    if !destination.is_dir() {
        return Some(format!("{} is not a directory", destination.display()));
    }
    match std::fs::read_dir(destination) {
        Ok(mut entries) => entries.next().map(|_| {
            format!(
                "{} is not empty. `fjord export` never writes over existing files",
                destination.display()
            )
        }),
        Err(err) => Some(format!("{}: {err}", destination.display())),
    }
}

/// Every file under `base`, as forward-slashed relative paths.
///
/// Symbolic links are skipped rather than followed: an import should bring
/// in the directory the user named, not wherever it points.
fn collect(base: &Path, relative: &str, found: &mut Vec<String>) -> Result<()> {
    let directory = if relative.is_empty() {
        base.to_path_buf()
    } else {
        base.join(relative)
    };
    let entries = std::fs::read_dir(&directory)
        .with_context(|| format!("could not read {}", directory.display()))?;

    for entry in entries {
        let entry = entry.with_context(|| format!("could not read {}", directory.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        let child = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };

        let metadata = std::fs::symlink_metadata(entry.path())
            .with_context(|| format!("could not read {}", entry.path().display()))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect(base, &child, found)?;
        } else {
            found.push(child);
        }
    }
    Ok(())
}

/// Keep `PathBuf` referenced for the signatures above.
#[allow(dead_code)]
type _PathBuf = PathBuf;

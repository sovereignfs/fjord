// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord new` — create a Doc with valid frontmatter. Spec §8.
//!
//! The acceptance criterion for this command is that what it writes passes
//! `fjord verify`, so everything it could get wrong is checked *before*
//! anything is written: the path rules of §5, the vault's encryption
//! settings, and whether the document already exists.
//!
//! In an encrypted vault the document is built in memory and written
//! encrypted. The plaintext never touches the vault, not even for the
//! instant between creating a file and encrypting it — invariant 1 has no
//! "briefly".

use crate::cli::{ExitCode, GlobalArgs, NewArgs, OpenArgs};
use crate::cmd::{ensure_writable, find_root, resolve_destination, usage, Style};
use anyhow::{Context, Result};
use fjord_core::vault::{self, Vault};
use fjord_core::{crypto, doc, path as rules, scalar, store};
use std::path::{Path, PathBuf};

pub fn run(args: &NewArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }

    let relative = match destination(&root, &args.path, args.document) {
        Ok(relative) => relative,
        Err(message) => return Ok(usage(message)),
    };

    // §5, enforced on the way in. This is the only path by which a name is
    // ever created, so it is the only place these rules can be applied
    // before the fact rather than reported after it.
    if let Some(message) = offending_component(&relative) {
        return Ok(usage(message));
    }

    let vault = match vault::containing(&root, &relative)
        .context("could not read the repository's vaults")?
    {
        Some(vault) => vault,
        None => {
            return Ok(usage(format!(
                "{relative} is not inside a vault. A Fjord Doc lives in a vault (spec §8); \
                 `fjord verify` lists the ones this repository has"
            )))
        }
    };

    // §7.2: in an id vault the leaf name *is* the identifier, so the id
    // has to exist before the path can be known.
    let id = scalar::new_ulid();
    let on_disk = match target_path(&vault, &relative, &id) {
        Ok(path) => path,
        Err(message) => return Ok(usage(message)),
    };
    if root.join(&on_disk).exists() {
        return Ok(usage(format!("{on_disk} already exists")));
    }

    // Prepared before writing, so a vault that cannot be written to is
    // refused rather than half-used.
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

    let title = match &args.title {
        Some(title) => title.clone(),
        None => default_title(&relative),
    };
    let contents = doc::new_document(&id, &title, &scalar::now_rfc3339_utc())
        .context("could not build the document's frontmatter")?;

    let absolute = root.join(&on_disk);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }

    let leaf = relative.rsplit('/').next().unwrap_or(&relative);
    let bytes = store::store(&vault, leaf, contents.as_bytes(), recipients.as_ref())
        .with_context(|| format!("could not encode {on_disk}"))?;
    write_new(&absolute, &bytes).with_context(|| format!("could not write {on_disk}"))?;

    let style = Style::detect();
    if !global.quiet {
        println!("  {} {on_disk}", style.good("created"));
        println!("  {} {id}", style.dim("id"));
    }

    if args.no_edit {
        return Ok(ExitCode::Ok);
    }

    // Editing reuses `fjord open`, which owns the lock, the temporary file
    // and the signal handling. Duplicating any of that here would be a
    // second place for it to be wrong.
    if crate::cmd::open::resolve_editor(None).is_none() {
        // The document exists, which is what was asked for; not opening it
        // is worth saying out loud but is not a failure.
        eprintln!(
            "note: no editor configured, so {on_disk} was not opened. \
             Set $EDITOR, or use `fjord open {}`",
            relative
        );
        return Ok(ExitCode::Ok);
    }

    let open = OpenArgs {
        path: PathBuf::from(&on_disk),
        editor: None,
        commit: false,
    };
    crate::cmd::open::run(&open, global)
}

/// Write a file that must not already exist.
fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create_new(path)?;
    file.write_all(bytes)?;
    Ok(())
}

/// Resolve where the document should go, for a path that does not exist
/// yet.
///
/// Accepts the same two spellings as every other command — relative to the
/// working directory, or to the repository root — preferring whichever has
/// an existing parent directory, and the repository root when neither does.
fn destination(root: &Path, input: &Path, document: bool) -> std::result::Result<String, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|err| format!("could not resolve {}: {err}", root.display()))?;

    let from_cwd = resolve_destination(input);
    let from_root = resolve_destination(&canonical_root.join(input));

    let candidates = if from_cwd.parent().map(Path::is_dir).unwrap_or(false) {
        [from_cwd, from_root]
    } else {
        [from_root, from_cwd]
    };

    for candidate in &candidates {
        if let Ok(relative) = candidate.strip_prefix(&canonical_root) {
            let relative = with_markdown_extension(&relative.to_string_lossy(), document)?;
            return Ok(relative);
        }
    }

    Err(format!(
        "{} is outside the repository at {}",
        input.display(),
        canonical_root.display()
    ))
}

/// A Fjord Doc is a `.md` file (§8), so a bare name gains the extension and
/// anything else is refused rather than silently made into a vault file
/// with frontmatter nobody will read.
///
/// With `document`, the name ends in `.fj.md` (§8.4): `plan` and `plan.md` become `plan.fj.md`, and a
/// name that already is one is kept. Without it, `plan.fj.md` is still a document: the name decides, and
/// nothing here has to be told.
fn with_markdown_extension(relative: &str, document: bool) -> std::result::Result<String, String> {
    let relative = relative.replace('\\', "/");
    let name = relative.rsplit('/').next().unwrap_or(&relative);

    if document && !doc::is_document_name(name) {
        let directory = &relative[..relative.len() - name.len()];
        let stem = match name.rsplit_once('.') {
            // A Markdown name loses its `.md` to gain `.fj.md`. (A dotfile such as `.md` has no stem.)
            Some((stem, "md")) if !stem.is_empty() => stem,
            Some((_, extension)) if extension != "md" && !name.starts_with('.') => {
                return Err(format!(
                    "a Fjord Doc is a Markdown file (spec §8), so `.{extension}` cannot carry \
                     frontmatter. Create it with your editor and bring it in with \
                     `fjord encrypt`"
                ))
            }
            _ => name,
        };
        return Ok(format!("{directory}{stem}{}", doc::DOCUMENT_SUFFIX));
    }

    match name.rsplit_once('.') {
        Some((_, "md")) => Ok(relative),
        // A dotfile, or a name with no extension.
        None => Ok(format!("{relative}.md")),
        Some(("", _)) => Ok(format!("{relative}.md")),
        Some((_, extension)) => Err(format!(
            "a Fjord Doc is a Markdown file (spec §8), so `.{extension}` cannot carry \
             frontmatter. Create it with your editor and bring it in with \
             `fjord encrypt`"
        )),
    }
}

/// Where the document actually lands.
///
/// The directory is kept as the user gave it — §7.2 conceals only leaf
/// names — and the leaf comes from [`store::on_disk_name`]: the document's
/// own name plus a suffix in `plain` mode, the ULID in `id` mode.
fn target_path(vault: &Vault, relative: &str, id: &str) -> std::result::Result<String, String> {
    let (directory, leaf) = match relative.rsplit_once('/') {
        Some((directory, leaf)) => (Some(directory), leaf),
        None => (None, relative),
    };

    let name = store::on_disk_name(vault, leaf, Some(id))
        .map_err(|err| format!("{relative} cannot be stored in this vault: {err}"))?;

    Ok(match directory {
        Some(directory) => format!("{directory}/{name}"),
        None => name,
    })
}

/// The first §5 rule any component of `relative` breaks.
fn offending_component(relative: &str) -> Option<String> {
    for component in relative.split('/') {
        let codes = rules::check_component(component);
        if let Some(code) = codes.first() {
            return Some(format!(
                "{component:?} cannot be used as a name: {} ({})",
                code.message(),
                code.as_str()
            ));
        }
    }
    None
}

/// The title a file name implies: `sync-design.md` and `sync-design.fj.md` both become `sync-design`.
fn default_title(relative: &str) -> String {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    let stem = if doc::is_document_name(name) {
        name.strip_suffix(doc::DOCUMENT_SUFFIX)
    } else {
        name.strip_suffix(".md")
    };
    stem.unwrap_or(name).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_name_becomes_markdown() {
        assert_eq!(
            with_markdown_extension("notes", false),
            Ok("notes.md".to_string())
        );
        assert_eq!(
            with_markdown_extension("Public/notes.md", false),
            Ok("Public/notes.md".to_string())
        );
    }

    #[test]
    fn another_extension_is_refused_with_a_way_forward() {
        match with_markdown_extension("Private/report.pdf", false) {
            Err(message) => {
                assert!(message.contains("§8"), "{message}");
                assert!(message.contains("fjord encrypt"), "{message}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_dotfile_still_gains_the_extension() {
        assert_eq!(
            with_markdown_extension("Public/.notes", false),
            Ok("Public/.notes.md".to_string())
        );
    }

    #[test]
    fn the_title_defaults_to_the_file_stem() {
        assert_eq!(default_title("Public/sync-design.md"), "sync-design");
        assert_eq!(default_title("notes.md"), "notes");
    }

    #[test]
    fn names_that_break_the_path_rules_are_refused() {
        // §5, applied before the file exists rather than diagnosed after.
        assert!(offending_component("Public/a?b.md").is_some());
        assert!(offending_component("Public/CON.md").is_some());
        assert!(offending_component("Public/notes .md").is_none());
        assert!(offending_component("Public/ok.md").is_none());

        let message = offending_component("Public/a?b.md").expect("a message");
        assert!(message.contains("E501"), "{message}");
    }

    #[test]
    fn a_component_over_255_bytes_is_refused() {
        // The only way this rule can ever fire: no mainstream filesystem
        // can store such a name, so it has to be caught before the write.
        let long = format!("Public/{}.md", "a".repeat(300));
        let message = offending_component(&long).expect("a message");
        assert!(message.contains("E504"), "{message}");
    }

    #[test]
    fn a_document_is_named_fj_md() {
        let named = |name: &str| with_markdown_extension(name, true);
        assert_eq!(named("plan"), Ok("plan.fj.md".to_string()));
        assert_eq!(named("plan.md"), Ok("plan.fj.md".to_string()));
        assert_eq!(
            named("Public/Q4/plan.md"),
            Ok("Public/Q4/plan.fj.md".to_string())
        );
        assert_eq!(
            named("Public/plan.fj.md"),
            Ok("Public/plan.fj.md".to_string())
        );
        assert_eq!(
            named("Public/.notes"),
            Ok("Public/.notes.fj.md".to_string())
        );
        // Still refused, with the same way forward, for what cannot carry frontmatter.
        assert!(named("Public/report.pdf")
            .unwrap_err()
            .contains("fjord encrypt"));
    }

    #[test]
    fn a_name_ending_in_fj_md_is_a_document_without_being_told() {
        assert_eq!(
            with_markdown_extension("Public/plan.fj.md", false),
            Ok("Public/plan.fj.md".to_string())
        );
    }

    #[test]
    fn a_documents_title_does_not_keep_its_suffix() {
        assert_eq!(default_title("Public/sync-design.fj.md"), "sync-design");
        assert_eq!(default_title("Public/sync-design.md"), "sync-design");
        assert_eq!(default_title("Public/fj.md"), "fj");
    }
}

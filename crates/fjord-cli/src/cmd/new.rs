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
use fjord_core::manifest::{Engine, Kind, Manifest};
use fjord_core::vault::{self, Vault};
use fjord_core::{crypto, doc, journal, path as rules, scalar, site, store, REPOSITORY_MANIFEST};
use std::path::{Path, PathBuf};

pub fn run(args: &NewArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }

    // With a path, a Doc where it is asked for. Without one, in a journal, an entry dated now and
    // filed by that date (spec §3.1).
    let (relative, date, post) = match &args.path {
        Some(path) => {
            if args.date.is_some() || args.draft {
                return Ok(usage(
                    "--date and --draft are for an entry or a post made without a path; \
                     a Doc at a path is dated by editing its `date`",
                ));
            }
            match destination(&root, path) {
                Ok(relative) => (relative, None, None),
                Err(message) => return Ok(usage(message)),
            }
        }
        None => match generated(&root, args)? {
            Ok(made) => (made.relative, Some(made.date), made.post),
            Err(message) => return Ok(usage(message)),
        },
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

    let contents = match (&date, &post) {
        // A site's post has what its engine reads.
        (Some(date), Some((engine, draft))) => site::new_post(
            engine,
            &id,
            args.title.as_deref().unwrap_or(""),
            &scalar::now_rfc3339_utc(),
            date,
            *draft,
        ),
        // An entry needs no title: it is read by its date.
        (Some(date), None) => {
            doc::new_entry(&id, args.title.as_deref(), &scalar::now_rfc3339_utc(), date)
        }
        _ => {
            let title = match &args.title {
                Some(title) => title.clone(),
                None => default_title(&relative),
            };
            doc::new_document(&id, &title, &scalar::now_rfc3339_utc())
        }
    }
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

/// What `fjord new` made up for itself, with no path to go on.
struct Generated {
    relative: String,
    date: String,
    /// For a site's post: its engine, and whether it is a draft.
    post: Option<(Engine, bool)>,
}

/// Where a new journal entry or site post goes, and its `date`, for `fjord new` with no path; or why there is none (spec §3.1).
fn generated(root: &Path, args: &NewArgs) -> Result<std::result::Result<Generated, String>> {
    let manifest = Manifest::parse(
        &std::fs::read(root.join(REPOSITORY_MANIFEST)).context("could not read fjord.json")?,
    )
    .map_err(|err| anyhow::anyhow!("fjord.json: {err}"))?;
    let kind = manifest.kind().declared();
    if kind != Kind::Journal && kind != Kind::Ssg {
        return Ok(Err(format!(
            "a path is required: this repository is a {}, and only a journal or a site makes \
             one without",
            kind.as_str()
        )));
    }

    let vaults = vault::discover(root).context("could not read the repository's vaults")?;
    let vault = match vaults.as_slice() {
        [vault] => vault,
        _ => {
            return Ok(Err(format!(
                "a {} has exactly one vault and this one has {} (`fjord verify` reports \
                 E111). Give a path",
                kind.as_str(),
                vaults.len()
            )))
        }
    };

    let date = match &args.date {
        Some(date) if scalar::is_rfc3339(date) => date.clone(),
        Some(date) => {
            return Ok(Err(format!(
                "--date {date} is not an RFC 3339 date-time with an offset, such as \
                 2026-11-02T08:14:00+05:30"
            )))
        }
        None => now_here(),
    };

    let (leaf, post) = if kind == Kind::Ssg {
        let engine =
            match manifest.ssg_engine() {
                Some(engine @ (Engine::Astro | Engine::Jekyll)) => engine,
                _ => return Ok(Err(
                    "this site's engine is not one this version knows (astro or jekyll), so it \
                     does not know where a post goes. Give a path"
                        .to_string(),
                )),
            };
        let title = args.title.as_deref().unwrap_or("");
        match site::post_path(&engine, &date, title, args.draft) {
            Some(leaf) => (leaf, Some((engine, args.draft))),
            None => return Ok(Err(format!("{date} cannot name a post"))),
        }
    } else {
        if args.draft {
            return Ok(Err("--draft is for a post in a site".to_string()));
        }
        match journal::entry_path(&date) {
            Some(leaf) => (leaf, None),
            None => return Ok(Err(format!("{date} cannot name an entry"))),
        }
    };
    // Two in one minute (or with one title): the second takes a number, as a copy does.
    let base = format!("{}/{leaf}", vault.directory);
    let mut relative = base.clone();
    let mut number = 2;
    while root.join(&relative).exists() {
        relative = format!("{}-{number}.md", base.trim_end_matches(".md"));
        number += 1;
    }
    Ok(Ok(Generated {
        relative,
        date,
        post,
    }))
}

/// Now, at this machine's offset from UTC, as a `date` (spec §8.1). Where the offset cannot be told
/// (some systems refuse to say while other threads run), UTC, and a note saying so.
fn now_here() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(0))
        .unwrap_or(0);
    let offset = match time::UtcOffset::current_local_offset() {
        Ok(offset) => i32::from(offset.whole_minutes()),
        Err(_) => {
            eprintln!(
                "note: this machine's offset from UTC could not be read, so the entry is dated in \
                 UTC. Pass --date to date it in your own time"
            );
            0
        }
    };
    scalar::rfc3339_from_unix_at_offset(now, offset).unwrap_or_else(scalar::now_rfc3339_utc)
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
fn destination(root: &Path, input: &Path) -> std::result::Result<String, String> {
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
            let relative = with_markdown_extension(&relative.to_string_lossy())?;
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
/// with frontmatter nobody will read. (`.fj.md` is no different from `.md`: spec §8.4.)
fn with_markdown_extension(relative: &str) -> std::result::Result<String, String> {
    let relative = relative.replace('\\', "/");
    let name = relative.rsplit('/').next().unwrap_or(&relative);

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

/// The title a file name implies: `sync-design.md` becomes `sync-design`.
fn default_title(relative: &str) -> String {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_name_becomes_markdown() {
        assert_eq!(with_markdown_extension("notes"), Ok("notes.md".to_string()));
        assert_eq!(
            with_markdown_extension("Public/notes.md"),
            Ok("Public/notes.md".to_string())
        );
    }

    #[test]
    fn another_extension_is_refused_with_a_way_forward() {
        match with_markdown_extension("Private/report.pdf") {
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
            with_markdown_extension("Public/.notes"),
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
    fn a_name_ending_in_fj_md_is_an_ordinary_markdown_name() {
        assert_eq!(
            with_markdown_extension("Public/plan.fj.md"),
            Ok("Public/plan.fj.md".to_string())
        );
    }

    #[test]
    fn only_the_md_comes_off_a_title() {
        assert_eq!(default_title("Public/sync-design.fj.md"), "sync-design.fj");
        assert_eq!(default_title("Public/sync-design.md"), "sync-design");
        assert_eq!(default_title("Public/fj.md"), "fj");
    }
}

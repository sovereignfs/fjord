// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord init` — create a conforming repository.
//!
//! Three things happen, in this order, and the order matters: everything
//! that can fail without touching the disk is checked first, then the files
//! are written, then git. A missing `git` is reported before any file
//! exists, rather than leaving a half-made repository behind.
//!
//! # Prompting
//!
//! [`ask`] is a plain function over a reader and a writer, and the terminal
//! check lives in [`run`]. That keeps the interactive path testable without
//! a pseudo-terminal: the tests drive `ask` directly with in-memory
//! buffers, and the end-to-end tests cover `--no-input`.

use crate::cli::{ExitCode, GlobalArgs, InitArgs};
use crate::cmd::{plural, usage, Style};
use crate::git::{Git, DEFAULT_BRANCH};
use anyhow::{Context, Result};
use fjord_core::scaffold::{
    self, KindChoice, KindSettings, Plan, SiteEngine, PRIVATE_VAULT, PUBLIC_VAULT,
};
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Component, Path, PathBuf};

pub fn run(args: &InitArgs, global: &GlobalArgs) -> Result<ExitCode> {
    if args.adopt {
        return crate::cmd::adopt::run(args, global);
    }
    if !args.vault.is_empty() || args.encrypt_existing {
        return Ok(usage(
            "--vault and --encrypt-existing are for --adopt, which makes a repository of a directory \
             that already has files",
        ));
    }
    if global.identity.is_some() {
        // Registering a recipient is `key add`, which arrives with M3.
        // Accepting the flag and ignoring it would produce a repository the
        // user believes they can write to.
        return Ok(usage(
            "an identity cannot be registered yet; that arrives with `fjord key add`. \
             Re-run without --identity (or unset FJORD_IDENTITY) and add the key by hand — \
             the generated README explains how",
        ));
    }

    let target = match &args.path {
        Some(path) => path.clone(),
        None => PathBuf::from("."),
    };

    if let Some(problem) = unscaffoldable(&target)? {
        return Ok(usage(problem));
    }

    let kind = args.kind.as_deref().unwrap_or("drive");
    if let Some(problem) = misplaced_flags(kind, args) {
        return Ok(usage(problem));
    }

    // Defaults, then the interactive overrides.
    let mut name = match &args.name {
        Some(name) => name.clone(),
        None => default_name(&target),
    };
    // A drive's Private vault and a journal are encrypted unless asked otherwise (spec §3.1).
    let mut encrypt = !args.no_encrypt;
    let mut engine = args.engine.as_deref().and_then(SiteEngine::parse);

    let interactive = !global.no_input && io::stdin().is_terminal();
    if interactive {
        let mut stdin = io::stdin().lock();
        let mut stderr = io::stderr();
        match kind {
            "drive" => {
                let answers = ask(&mut stdin, &mut stderr, &name, encrypt)?;
                name = answers.0;
                encrypt = answers.1;
            }
            _ => {
                name = ask_name(&mut stdin, &mut stderr, &name)?;
                if kind == "journal" && !args.no_encrypt {
                    encrypt = ask_yes_no(&mut stdin, &mut stderr, "Encrypt the journal?", true)?;
                }
                if kind == "ssg" && engine.is_none() {
                    engine = ask_engine(&mut stdin, &mut stderr)?;
                }
            }
        }
    }

    let choice = match kind {
        "journal" => KindChoice::Journal { encrypted: encrypt },
        "ssg" => match engine {
            Some(engine) => KindChoice::Ssg { engine },
            None => {
                return Ok(usage(
                    "--kind ssg needs --engine astro or --engine jekyll: the site's engine \
                     decides what is scaffolded",
                ))
            }
        },
        _ => KindChoice::Drive {
            encrypt_private: encrypt,
        },
    };

    // Checked before writing, so a missing git never leaves a repository
    // half-made.
    if !args.no_git && !Git::is_available() {
        anyhow::bail!(
            "`git` is not on PATH. Install it, or pass --no-git to create the \
             repository without initialising one"
        );
    }

    let settings = KindSettings {
        name: name.clone(),
        // The binary's name and the version it was built as, from the same
        // `CARGO_PKG_VERSION` that `fjord --version` prints. Compiled in, so
        // it follows every version bump with nothing to edit — and a test
        // compares it with `--version` itself rather than with a literal.
        generator: concat!("fjord ", env!("CARGO_PKG_VERSION")).to_string(),
        kind: choice,
    };

    let plan = scaffold::plan_kind(&settings);
    scaffold::write(&target, &plan)
        .with_context(|| format!("could not create a repository in {}", target.display()))?;

    if !args.no_git {
        // The scaffolding has already succeeded at this point, so say so:
        // the user needs to know the repository exists and only the commit
        // is missing, or they will try to create it again and be told the
        // directory is not empty.
        commit(&target).with_context(|| {
            format!(
                "the repository in {} was created, but git was not initialised. \
                 Fix the problem below, then finish with `git add -A && \
                 git commit -m \"Initial Fjord repository\"`",
                target.display()
            )
        })?;
    }

    if global.json {
        println!("{}", render_json(&target, &settings, &plan, !args.no_git));
    } else if !global.quiet {
        report(&target, &settings, &plan, Style::detect())?;
    }

    Ok(ExitCode::Ok)
}

fn commit(target: &Path) -> Result<()> {
    let repository = Git::new(target);
    // `git init` inside an existing working tree would create a nested
    // repository, which is almost never what someone meant.
    if !repository.is_repository() {
        repository.init(DEFAULT_BRANCH)?;
    }
    repository.add_all()?;
    repository.commit("Initial Fjord repository")?;
    Ok(())
}

/// A flag that does not belong to the kind being made, if one was given. Ignoring it would make a
/// repository other than the one asked for.
fn misplaced_flags(kind: &str, args: &InitArgs) -> Option<String> {
    if args.engine.is_some() && kind != "ssg" {
        return Some("--engine is for --kind ssg".to_string());
    }
    if args.no_encrypt && kind == "ssg" {
        return Some(
            "a site's content is never encrypted: it is published (spec §3.1), so --no-encrypt \
             has nothing to do"
                .to_string(),
        );
    }
    None
}

/// Whether the vault at `path` of a plan is encrypted.
fn is_encrypted(settings: &KindSettings, path: &str) -> bool {
    match settings.kind {
        KindChoice::Drive { encrypt_private } => encrypt_private && path == PRIVATE_VAULT,
        KindChoice::Journal { encrypted } => encrypted,
        KindChoice::Ssg { .. } => false,
    }
}

fn kind_name(settings: &KindSettings) -> &'static str {
    match settings.kind {
        KindChoice::Drive { .. } => "drive",
        KindChoice::Journal { .. } => "journal",
        KindChoice::Ssg { .. } => "ssg",
    }
}

/// Why `target` cannot be scaffolded, if it cannot.
///
/// An existing `.git` is tolerated, so that `git init && fjord init` works;
/// anything else means someone's files are already there.
fn unscaffoldable(target: &Path) -> Result<Option<String>> {
    if !target.exists() {
        return Ok(None);
    }
    if !target.is_dir() {
        return Ok(Some(format!("{} is not a directory", target.display())));
    }

    let entries = std::fs::read_dir(target)
        .with_context(|| format!("could not read {}", target.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("could not read {}", target.display()))?;
        let name = entry.file_name();
        if name != ".git" {
            return Ok(Some(format!(
                "{} is not empty (it contains {}). `fjord init` never writes over \
                 existing files",
                target.display(),
                name.to_string_lossy()
            )));
        }
    }
    Ok(None)
}

/// The repository name a directory implies.
fn default_name(target: &Path) -> String {
    let resolved = match std::fs::canonicalize(target) {
        Ok(canonical) => canonical,
        Err(_) => std::path::absolute(target).unwrap_or_else(|_| target.to_path_buf()),
    };
    resolved
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().to_string()),
            _ => None,
        })
        .next_back()
        .unwrap_or_else(|| "Fjord".to_string())
}

// --- Prompting -----------------------------------------------------------

/// Ask for the repository name and whether to encrypt `Private`.
///
/// Prompts go to the writer the caller supplies — stderr in practice, so
/// that `--json` on stdout stays machine-readable even when a prompt
/// happens. Returns the name and the encryption choice.
///
/// `encrypt_default` of `false` means `--no-encrypt` was given, which is an
/// answer already: the question is not asked again.
pub fn ask(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    name_default: &str,
    encrypt_default: bool,
) -> io::Result<(String, bool)> {
    write!(writer, "Repository name [{name_default}]: ")?;
    writer.flush()?;
    let name = match read_line(reader)? {
        Some(line) if !line.trim().is_empty() => line.trim().to_string(),
        _ => name_default.to_string(),
    };

    let encrypt = if encrypt_default {
        ask_yes_no(reader, writer, "Encrypt the Private vault?", true)?
    } else {
        false
    };

    Ok((name, encrypt))
}

/// Ask for the repository name alone.
pub fn ask_name(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    name_default: &str,
) -> io::Result<String> {
    write!(writer, "Repository name [{name_default}]: ")?;
    writer.flush()?;
    Ok(match read_line(reader)? {
        Some(line) if !line.trim().is_empty() => line.trim().to_string(),
        _ => name_default.to_string(),
    })
}

/// Ask for a site's engine. `None` after three answers that are not one, or at the end of input:
/// there is no default engine, so the caller refuses rather than guess.
pub fn ask_engine(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
) -> io::Result<Option<SiteEngine>> {
    for _ in 0..3 {
        write!(writer, "Site engine (astro, jekyll): ")?;
        writer.flush()?;
        let line = match read_line(reader)? {
            Some(line) => line,
            None => return Ok(None),
        };
        match SiteEngine::parse(line.trim().to_lowercase().as_str()) {
            Some(engine) => return Ok(Some(engine)),
            None => writeln!(writer, "Please answer astro or jekyll.")?,
        }
    }
    Ok(None)
}

fn ask_yes_no(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    question: &str,
    default: bool,
) -> io::Result<bool> {
    let hint = if default { "[Y/n]" } else { "[y/N]" };
    // Three attempts, then the default. A prompt must never become a loop
    // that cannot be escaped.
    for _ in 0..3 {
        write!(writer, "{question} {hint}: ")?;
        writer.flush()?;
        let line = match read_line(reader)? {
            Some(line) => line,
            // End of input: take the default rather than hang or fail.
            None => return Ok(default),
        };
        match line.trim().to_lowercase().as_str() {
            "" => return Ok(default),
            "y" | "yes" => return Ok(true),
            "n" | "no" => return Ok(false),
            _ => writeln!(writer, "Please answer y or n.")?,
        }
    }
    Ok(default)
}

fn read_line(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    Ok(Some(line))
}

// --- Output --------------------------------------------------------------

fn report(target: &Path, settings: &KindSettings, plan: &Plan, style: Style) -> Result<()> {
    match settings.kind {
        KindChoice::Drive { encrypt_private } => {
            report_drive(target, settings, plan, encrypt_private, style)
        }
        _ => report_kind(target, settings, plan, style),
    }
}

/// A journal or a site: one vault, presented as the thing itself.
fn report_kind(target: &Path, settings: &KindSettings, plan: &Plan, style: Style) -> Result<()> {
    let out = io::stdout();
    let mut out = out.lock();
    let (what, detail) = match settings.kind {
        KindChoice::Journal { encrypted: true } => {
            ("journal", "encrypted · no recipients yet".to_string())
        }
        KindChoice::Journal { encrypted: false } => ("journal", "plaintext".to_string()),
        KindChoice::Ssg { engine } => ("site", format!("plaintext · {}", engine.as_str())),
        KindChoice::Drive { .. } => ("drive", String::new()),
    };
    writeln!(
        out,
        "  {} {} in {}",
        style.good(&format!("created {what}")),
        settings.name,
        target.display()
    )?;
    writeln!(out)?;
    for (path, _) in &plan.vaults {
        writeln!(out, "    {:<12}{}", format!("{path}/"), style.dim(&detail))?;
    }
    if let Some((vault, _)) = plan.vaults.first() {
        if is_encrypted(settings, vault) {
            writeln!(out)?;
            writeln!(
                out,
                "  {vault} has no keys yet, so nothing can be written to it. Add one:"
            )?;
            writeln!(out)?;
            writeln!(out, "      age-keygen -o ~/.config/fjord/identity.txt")?;
            writeln!(
                out,
                "      age-keygen -y ~/.config/fjord/identity.txt >> {vault}/recipients.txt"
            )?;
            writeln!(out)?;
            writeln!(
                out,
                "  {}",
                style.dim("Until then `fjord verify` reports W602. That is expected.")
            )?;
        }
    }
    if matches!(settings.kind, KindChoice::Journal { .. }) {
        writeln!(out)?;
        writeln!(
            out,
            "  {}",
            style.dim("`fjord new` with no path writes today's entry.")
        )?;
    }
    writeln!(out)?;
    writeln!(out, "  {}", style.dim("README.md explains the layout."))?;
    Ok(())
}

fn report_drive(
    target: &Path,
    settings: &KindSettings,
    plan: &Plan,
    encrypt_private: bool,
    style: Style,
) -> Result<()> {
    let out = io::stdout();
    let mut out = out.lock();

    let documents = plan
        .files
        .iter()
        .filter(|file| file.path.ends_with(".md") && file.path.contains('/'))
        .count();

    writeln!(
        out,
        "  {} {} in {}",
        style.good("created"),
        settings.name,
        target.display()
    )?;
    writeln!(out)?;
    writeln!(
        out,
        "    {PUBLIC_VAULT:<12}{}",
        style.dim(&format!("plaintext · {}", plural(documents, "doc", "docs")))
    )?;
    writeln!(
        out,
        "    {PRIVATE_VAULT:<12}{}",
        style.dim(if encrypt_private {
            "encrypted · no recipients yet"
        } else {
            "plaintext"
        })
    )?;

    if encrypt_private {
        // Spec §6.2: a vault with no recipients is valid and unwritable.
        // Say so plainly, and say what `fjord verify` will report, so the
        // warning is not a surprise.
        writeln!(out)?;
        writeln!(
            out,
            "  {PRIVATE_VAULT} has no keys yet, so nothing can be written to it. Add one:"
        )?;
        writeln!(out)?;
        writeln!(out, "      age-keygen -o ~/.config/fjord/identity.txt")?;
        writeln!(
            out,
            "      age-keygen -y ~/.config/fjord/identity.txt >> {PRIVATE_VAULT}/recipients.txt"
        )?;
        writeln!(out)?;
        writeln!(
            out,
            "  {}",
            style.dim("Until then `fjord verify` reports W602. That is expected.")
        )?;
    }

    writeln!(out)?;
    writeln!(out, "  {}", style.dim("README.md explains the format."))?;
    Ok(())
}

fn render_json(
    target: &Path,
    settings: &KindSettings,
    plan: &Plan,
    git_initialised: bool,
) -> String {
    let vaults: Vec<serde_json::Value> = plan
        .vaults
        .iter()
        .map(|(path, id)| {
            serde_json::json!({
                "path": path,
                "id": id,
                "encrypted": is_encrypted(settings, path),
            })
        })
        .collect();

    let document = serde_json::json!({
        "tool": concat!("fjord ", env!("CARGO_PKG_VERSION")),
        "path": target.display().to_string(),
        "name": settings.name,
        "kind": kind_name(settings),
        "repositoryId": plan.repository_id,
        "createdAt": plan.created_at,
        "vaults": vaults,
        "files": plan.paths(),
        "git": {
            "initialised": git_initialised,
            "branch": if git_initialised { Some(DEFAULT_BRANCH) } else { None },
        },
    });

    serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Drive `ask` the way a terminal would, without needing one.
    fn answer(input: &str, name_default: &str, encrypt_default: bool) -> (String, bool, String) {
        let mut reader = Cursor::new(input.as_bytes().to_vec());
        let mut written = Vec::new();
        let answers = match ask(&mut reader, &mut written, name_default, encrypt_default) {
            Ok(answers) => answers,
            Err(err) => panic!("{err}"),
        };
        (
            answers.0,
            answers.1,
            String::from_utf8_lossy(&written).to_string(),
        )
    }

    #[test]
    fn empty_answers_take_the_defaults() {
        let (name, encrypt, prompts) = answer("\n\n", "my-documents", true);
        assert_eq!(name, "my-documents");
        assert!(encrypt);
        assert!(prompts.contains("[my-documents]"));
        assert!(prompts.contains("[Y/n]"));
    }

    #[test]
    fn a_name_can_be_given() {
        let (name, _, _) = answer("Research notes\n\n", "my-documents", true);
        assert_eq!(name, "Research notes");
    }

    #[test]
    fn whitespace_is_trimmed_and_falls_back() {
        let (name, _, _) = answer("   \n\n", "my-documents", true);
        assert_eq!(name, "my-documents");
        let (name, _, _) = answer("  Notes  \n\n", "my-documents", true);
        assert_eq!(name, "Notes");
    }

    #[test]
    fn encryption_can_be_declined() {
        for input in ["\nn\n", "\nN\n", "\nno\n", "\nNO\n"] {
            let (_, encrypt, _) = answer(input, "x", true);
            assert!(!encrypt, "{input:?} should decline encryption");
        }
        for input in ["\ny\n", "\nyes\n", "\nY\n"] {
            let (_, encrypt, _) = answer(input, "x", true);
            assert!(encrypt, "{input:?} should accept encryption");
        }
    }

    #[test]
    fn a_nonsense_answer_is_re_asked() {
        let (_, encrypt, prompts) = answer("\nmaybe\nn\n", "x", true);
        assert!(!encrypt);
        assert!(prompts.contains("Please answer y or n."));
    }

    #[test]
    fn three_nonsense_answers_fall_back_to_the_default() {
        // A prompt must not become an inescapable loop.
        let (_, encrypt, _) = answer("\nwhat\neh\nhmm\n", "x", true);
        assert!(encrypt);
    }

    #[test]
    fn end_of_input_takes_the_default() {
        let (name, encrypt, _) = answer("", "my-documents", true);
        assert_eq!(name, "my-documents");
        assert!(encrypt);
    }

    #[test]
    fn no_encrypt_is_not_re_asked() {
        // --no-encrypt is an answer already.
        let (_, encrypt, prompts) = answer("\n", "x", false);
        assert!(!encrypt);
        assert!(!prompts.contains("Encrypt"));
    }

    #[test]
    fn a_directory_name_becomes_the_repository_name() {
        assert_eq!(default_name(Path::new("/tmp/my-documents")), "my-documents");
        assert_eq!(default_name(Path::new("my-documents/")), "my-documents");
    }

    #[test]
    fn an_existing_git_directory_does_not_block_scaffolding() {
        let temp = match tempfile::tempdir() {
            Ok(temp) => temp,
            Err(err) => panic!("{err}"),
        };
        match std::fs::create_dir(temp.path().join(".git")) {
            Ok(()) => {}
            Err(err) => panic!("{err}"),
        }
        match unscaffoldable(temp.path()) {
            Ok(None) => {}
            other => panic!("expected a .git-only directory to be usable, got {other:?}"),
        }
    }

    #[test]
    fn a_non_empty_directory_is_refused() {
        let temp = match tempfile::tempdir() {
            Ok(temp) => temp,
            Err(err) => panic!("{err}"),
        };
        match std::fs::write(temp.path().join("notes.md"), "hello") {
            Ok(()) => {}
            Err(err) => panic!("{err}"),
        }
        match unscaffoldable(temp.path()) {
            Ok(Some(problem)) => assert!(problem.contains("not empty"), "{problem}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}

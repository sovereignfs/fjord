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
use fjord_core::scaffold::{self, Plan, Settings, PRIVATE_VAULT, PUBLIC_VAULT};
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Component, Path, PathBuf};

pub fn run(args: &InitArgs, global: &GlobalArgs) -> Result<ExitCode> {
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

    // Defaults, then the interactive overrides.
    let mut name = match &args.name {
        Some(name) => name.clone(),
        None => default_name(&target),
    };
    let mut encrypt = !args.no_encrypt;

    let interactive = !global.no_input && io::stdin().is_terminal();
    if interactive {
        let mut stdin = io::stdin().lock();
        let mut stderr = io::stderr();
        let answers = ask(&mut stdin, &mut stderr, &name, encrypt)?;
        name = answers.0;
        encrypt = answers.1;
    }

    // Checked before writing, so a missing git never leaves a repository
    // half-made.
    if !args.no_git && !Git::is_available() {
        anyhow::bail!(
            "`git` is not on PATH. Install it, or pass --no-git to create the \
             repository without initialising one"
        );
    }

    let settings = Settings {
        name: name.clone(),
        encrypt_private: encrypt,
        // The binary's name and the version it was built as, from the same
        // `CARGO_PKG_VERSION` that `fjord --version` prints. Compiled in, so
        // it follows every version bump with nothing to edit — and a test
        // compares it with `--version` itself rather than with a literal.
        generator: concat!("fjord ", env!("CARGO_PKG_VERSION")).to_string(),
    };

    let plan = scaffold::plan(&settings);
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

fn report(target: &Path, settings: &Settings, plan: &Plan, style: Style) -> Result<()> {
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
        style.dim(if settings.encrypt_private {
            "encrypted · no recipients yet"
        } else {
            "plaintext"
        })
    )?;

    if settings.encrypt_private {
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

fn render_json(target: &Path, settings: &Settings, plan: &Plan, git_initialised: bool) -> String {
    let vaults: Vec<serde_json::Value> = plan
        .vaults
        .iter()
        .map(|(path, id)| {
            serde_json::json!({
                "path": path,
                "id": id,
                "encrypted": path == PRIVATE_VAULT && settings.encrypt_private,
            })
        })
        .collect();

    let document = serde_json::json!({
        "tool": concat!("fjord ", env!("CARGO_PKG_VERSION")),
        "path": target.display().to_string(),
        "name": settings.name,
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

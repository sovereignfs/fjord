// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord open` — edit an encrypted document in any editor.
//!
//! This is the command the encryption is for: it makes vim, VS Code,
//! Obsidian or anything else usable on an encrypted document without
//! plaintext ever entering the repository.
//!
//! # Where the plaintext lives
//!
//! In a temporary file **outside the repository**, created by `tempfile`
//! with owner-only permissions. Invariant 1 admits no exception for "just
//! while editing", and §6.5's guard `.gitignore` is a safety net, not a
//! licence to put plaintext in a vault. The temporary file is removed when
//! the session ends, whether that is a clean exit, a failed decryption, or
//! a signal (§11.3 makes removal a MUST).
//!
//! # The four things that go wrong
//!
//! 1. **GUI editors fork.** `code notes.md` returns immediately, so the
//!    session would end before the user had typed anything. Fjord appends
//!    `--wait` for editors it recognises.
//! 2. **Reading is not writing.** If the plaintext is byte-identical
//!    afterwards, nothing is re-encrypted: age output is non-deterministic,
//!    so re-encrypting an unchanged document would write a completely new
//!    object that Git cannot delta-compress, for no reason.
//! 3. **Sessions get interrupted.** SIGINT and SIGTERM shred the temporary
//!    file and release the lock before exiting.
//! 4. **Two sessions, one file.** A lock under `/.fjord/local/`, which §2.2
//!    reserves for client machinery and the generated `.gitignore` excludes
//!    from commits, prevents a second `open` of the same document silently
//!    discarding the first one's edits.

use crate::cli::{ExitCode, GlobalArgs, OpenArgs};
use crate::cmd::{ensure_writable, find_root, load_identities, repo_relative, usage, Style};
use crate::git::Git;
use anyhow::{Context, Result};
use fjord_core::crypto;
use fjord_core::vault::{self, Vault};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn run(args: &OpenArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;

    // Invariant 4: never write to a repository made by a newer Fjord.
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }

    let editor = match resolve_editor(args.editor.as_deref()) {
        Some(editor) => editor,
        None => {
            return Ok(usage(
                "no editor configured. Set $EDITOR or $VISUAL, or pass --editor <cmd>. \
                 For an editor that opens a window and returns immediately, include a \
                 flag that makes it wait, e.g. --editor \"code --wait\"",
            ))
        }
    };

    let relative = match target(&root, &args.path)? {
        Ok(relative) => relative,
        Err(message) => return Ok(usage(message)),
    };

    let vault =
        vault::containing(&root, &relative).context("could not read the repository's vaults")?;

    match vault {
        Some(vault) if vault.is_encrypted() => {
            open_encrypted(&root, &vault, &relative, &editor, args, global)
        }
        // A plaintext file needs no ceremony: hand it to the editor.
        _ => open_plaintext(&root, &relative, &editor, args, global),
    }
}

/// Resolve what the user asked for into the file that actually holds the
/// document.
///
/// `fjord open Private/notes.md` finds `Private/notes.md.age`, because the
/// payload's name is an implementation detail the user should not have to
/// type.
fn target(root: &Path, input: &Path) -> Result<std::result::Result<String, String>> {
    let direct = repo_relative(root, input)?;
    if direct.is_ok() {
        return Ok(direct);
    }

    // Then the payload name, for each encrypted vault's suffix.
    for vault in vault::discover(root).context("could not read the repository's vaults")? {
        if !vault.is_encrypted() {
            continue;
        }
        let candidate = PathBuf::from(format!("{}{}", input.to_string_lossy(), vault.suffix()));
        if let Ok(relative) = repo_relative(root, &candidate)? {
            return Ok(Ok(relative));
        }
    }

    // Neither spelling resolved, so report what was wrong with the one the
    // user actually typed.
    Ok(direct)
}

fn open_encrypted(
    root: &Path,
    vault: &Vault,
    relative: &str,
    editor: &Editor,
    args: &OpenArgs,
    global: &GlobalArgs,
) -> Result<ExitCode> {
    let suffix = vault.suffix();
    if !relative.ends_with(&suffix) {
        return Ok(usage(format!(
            "{relative} is in the clear inside an encrypted vault. Encrypt it first \
             with `fjord encrypt {relative}`"
        )));
    }

    // Checked before anything is decrypted: a session that cannot be saved
    // should not be started.
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
            "the {} vault has no recipients, so an edit could not be saved. \
             Add one with `fjord key add`",
            vault.directory
        )));
    }

    let lock = match Lock::acquire(root, relative)? {
        Ok(lock) => lock,
        Err(message) => return Ok(usage(message)),
    };

    let identities = load_identities(global)?;
    let payload = root.join(relative);
    let ciphertext =
        std::fs::read(&payload).with_context(|| format!("could not read {relative}"))?;
    let plaintext = crypto::decrypt(&ciphertext, &identities)
        .with_context(|| format!("could not decrypt {relative}"))?;

    // Outside the repository, owner-only, and named so the editor sees the
    // document's real extension and syntax-highlights it.
    let scratch = tempfile::Builder::new()
        .prefix("fjord-")
        .suffix(&scratch_suffix(relative, &suffix))
        .tempfile()
        .context("could not create a temporary file for the decrypted document")?;
    let (mut handle, scratch_path) = scratch.into_parts();
    handle
        .write_all(&plaintext[..])
        .context("could not write the decrypted document")?;
    handle
        .flush()
        .context("could not flush the decrypted document")?;
    drop(handle);

    let before = blake3::hash(&plaintext[..]);

    // From here on the plaintext exists on disk, so a signal must clean it
    // up rather than leave it behind (§11.3).
    let guard = install_signal_handler(scratch_path.to_path_buf(), lock.path.clone());

    let status = editor.launch(&scratch_path);

    // Back in control: the handler must not fire during the rest of this.
    guard.disarm();

    let status = status.with_context(|| format!("could not run {}", editor.program))?;

    let edited = std::fs::read(&scratch_path).map(zeroize::Zeroizing::new);
    let edited = match edited {
        Ok(edited) => edited,
        Err(err) => {
            shred(&scratch_path);
            return Err(anyhow::Error::new(err)
                .context("the decrypted document disappeared during the session"));
        }
    };

    let style = Style::detect();
    if !status.success() {
        // The exit code of a GUI editor is not a reliable signal, and
        // discarding someone's edits on the strength of one would be worse
        // than persisting them. Say so and carry on.
        eprintln!(
            "warning: {} exited with {}",
            editor.program,
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "a signal".to_string())
        );
    }

    if blake3::hash(&edited[..]) == before {
        shred(&scratch_path);
        if !global.quiet {
            println!("  {} {relative}", style.dim("unchanged"));
        }
        return Ok(ExitCode::Ok);
    }

    let ciphertext = crypto::encrypt(&edited, &recipients, vault.armor())
        .with_context(|| format!("could not re-encrypt {relative}"))?;

    // Write through a temporary file in the same directory, so an
    // interrupted write cannot leave a truncated payload where a readable
    // one used to be.
    let written = write_atomically(&payload, &ciphertext);
    shred(&scratch_path);
    written.with_context(|| format!("could not write {relative}"))?;
    drop(lock);

    if !global.quiet {
        println!("  {} {relative}", style.good("re-encrypted"));
    }

    if args.commit {
        commit(root, relative)?;
        if !global.quiet {
            println!("  {} {relative}", style.dim("committed"));
        }
    }

    Ok(ExitCode::Ok)
}

fn open_plaintext(
    root: &Path,
    relative: &str,
    editor: &Editor,
    args: &OpenArgs,
    global: &GlobalArgs,
) -> Result<ExitCode> {
    let lock = match Lock::acquire(root, relative)? {
        Ok(lock) => lock,
        Err(message) => return Ok(usage(message)),
    };

    let path = root.join(relative);
    let before = std::fs::read(&path)
        .map(|bytes| blake3::hash(&bytes))
        .with_context(|| format!("could not read {relative}"))?;

    let status = editor
        .launch(&path)
        .with_context(|| format!("could not run {}", editor.program))?;
    if !status.success() {
        eprintln!("warning: {} exited unsuccessfully", editor.program);
    }

    let after = std::fs::read(&path)
        .map(|bytes| blake3::hash(&bytes))
        .with_context(|| format!("could not read {relative}"))?;
    drop(lock);

    let style = Style::detect();
    if after == before {
        if !global.quiet {
            println!("  {} {relative}", style.dim("unchanged"));
        }
        return Ok(ExitCode::Ok);
    }

    if !global.quiet {
        println!("  {} {relative}", style.good("saved"));
    }
    if args.commit {
        commit(root, relative)?;
        if !global.quiet {
            println!("  {} {relative}", style.dim("committed"));
        }
    }
    Ok(ExitCode::Ok)
}

fn commit(root: &Path, relative: &str) -> Result<()> {
    let repository = Git::new(root);
    repository.add_path(relative)?;
    // Only this document. A bare `git commit` takes the whole index, so
    // anything already staged would land in a commit saying "Edit <file>".
    repository.commit_paths(&format!("Edit {relative}"), &[relative])?;
    Ok(())
}

/// Replace a file without ever leaving it half-written.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".fjord-write-")
        .tempfile_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

/// The suffix a scratch file should carry, so an editor recognises the
/// document's type: `notes.md.age` becomes `…-notes.md`.
fn scratch_suffix(relative: &str, suffix: &str) -> String {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    let stem = name.strip_suffix(suffix).unwrap_or(name);
    format!("-{stem}")
}

/// Overwrite a decrypted file before removing it.
///
/// Best-effort, and deliberately described that way: on an SSD or a
/// copy-on-write filesystem the original blocks may survive regardless, and
/// claiming otherwise would be a lie a user might rely on.
fn shred(path: &Path) {
    if let Ok(metadata) = std::fs::metadata(path) {
        let length = metadata.len();
        if length > 0 {
            if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(path) {
                let zeros = [0u8; 8192];
                let mut remaining = length;
                while remaining > 0 {
                    let chunk = remaining.min(zeros.len() as u64) as usize;
                    if file.write_all(&zeros[..chunk]).is_err() {
                        break;
                    }
                    remaining -= chunk as u64;
                }
                let _ = file.sync_all();
            }
        }
    }
    let _ = std::fs::remove_file(path);
}

// --- Editors -------------------------------------------------------------

/// Editors that open a window and return immediately, with the flag that
/// makes them block. Spec silence; README documents the list.
const WAIT_FLAGS: &[(&str, &str)] = &[
    ("code", "--wait"),
    ("code-insiders", "--wait"),
    ("codium", "--wait"),
    ("subl", "--wait"),
    ("sublime_text", "--wait"),
    ("zed", "--wait"),
    ("mate", "--wait"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Editor {
    pub program: String,
    pub arguments: Vec<String>,
}

impl Editor {
    fn launch(&self, path: &Path) -> std::io::Result<std::process::ExitStatus> {
        // Inherits stdio, so a terminal editor takes over the terminal.
        Command::new(&self.program)
            .args(&self.arguments)
            .arg(path)
            .status()
    }
}

/// Work out which editor to run, in the order a user expects.
///
/// `--editor`, then `$VISUAL`, then `$EDITOR`. No fallback to `vi`: a
/// guessed editor that is not installed fails in a way that looks like a
/// Fjord bug, where an explicit message does not.
pub fn resolve_editor(explicit: Option<&str>) -> Option<Editor> {
    let command = match explicit {
        Some(command) => command.to_string(),
        None => std::env::var("VISUAL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("EDITOR")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            })?,
    };
    parse_editor(&command)
}

/// Split an editor command and add a wait flag if it needs one.
///
/// Splitting on whitespace is the same approximation Git makes, and it is
/// the reason `--editor` exists: a path containing a space needs the flag
/// rather than the variable.
pub fn parse_editor(command: &str) -> Option<Editor> {
    let mut parts = command.split_whitespace();
    let program = parts.next()?.to_string();
    let mut arguments: Vec<String> = parts.map(String::from).collect();

    let stem = Path::new(&program)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| program.clone());

    if let Some((_, flag)) = WAIT_FLAGS.iter().find(|(name, _)| *name == stem) {
        // Only if the user has not already said how to wait.
        let already = arguments
            .iter()
            .any(|argument| argument == flag || argument == "-w");
        if !already {
            arguments.push((*flag).to_string());
        }
    }

    Some(Editor { program, arguments })
}

// --- Signals -------------------------------------------------------------

/// Removes the decrypted file and the lock if a signal arrives.
struct SignalGuard {
    armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl SignalGuard {
    /// Stop the handler acting, once the main path has taken over cleanup.
    fn disarm(&self) {
        self.armed.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Shred `scratch` and release `lock` if the session is interrupted.
///
/// Spec §11.3: a client MUST remove temporary decrypted files when an
/// external editing session ends. An interrupted session is still an ended
/// one, and Ctrl-C during an edit is the most ordinary way for that to
/// happen — on every platform, which is why this is `ctrlc` and not
/// `signal-hook`, whose iterator API is Unix-only. With `termination` it
/// covers SIGINT, SIGTERM and SIGHUP on Unix, and Ctrl+C, Ctrl+Break and
/// console-close on Windows.
fn install_signal_handler(scratch: PathBuf, lock: PathBuf) -> SignalGuard {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let armed = Arc::new(AtomicBool::new(true));
    let watching = Arc::clone(&armed);

    // Set once per process, which is all a CLI invocation needs.
    match ctrlc::set_handler(move || {
        if watching.load(Ordering::SeqCst) {
            shred(&scratch);
            let _ = std::fs::remove_file(&lock);
        }
        // 130 is the conventional code for a SIGINT death, and the shell
        // shows it as such. Exiting either way: once the handler is
        // installed, nothing else is going to stop the process.
        std::process::exit(130);
    }) {
        Ok(()) => {}
        Err(err) => {
            // Not fatal: the session can still proceed, but the user
            // should know that an interruption will leave plaintext
            // behind.
            eprintln!(
                "warning: could not install a signal handler ({err}); interrupting this \
                 session may leave the decrypted file behind"
            );
        }
    }

    SignalGuard { armed }
}

// --- Locking -------------------------------------------------------------

/// Prevents two sessions editing one document at once.
///
/// Lives under `/.fjord/local/`, which §2.2 reserves for client machinery
/// and the generated `.gitignore` keeps out of commits. Never inside a
/// vault: a lock file in an encrypted vault would be plaintext in the one
/// place it must not be.
#[derive(Debug)]
struct Lock {
    path: PathBuf,
}

impl Lock {
    fn acquire(root: &Path, relative: &str) -> Result<std::result::Result<Self, String>> {
        let directory = root.join(".fjord").join("local").join("locks");
        std::fs::create_dir_all(&directory)
            .with_context(|| format!("could not create {}", directory.display()))?;

        // Named by digest so that any path, however deep or oddly spelled,
        // becomes one safe file name.
        let digest = blake3::hash(relative.as_bytes()).to_hex();
        let path = directory.join(format!("{}.lock", &digest.as_str()[..16]));

        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        match options.open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}\npid {}\n", relative, std::process::id());
                Ok(Ok(Self { path }))
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                let held_by = std::fs::read_to_string(&path).unwrap_or_default();
                let held_by = held_by
                    .lines()
                    .nth(1)
                    .unwrap_or("an unknown process")
                    .to_string();
                Ok(Err(format!(
                    "{relative} is already open ({held_by}). Two sessions editing one \
                     document means one set of edits is lost. If that process is gone, \
                     remove {}",
                    path.display()
                )))
            }
            Err(err) => {
                Err(anyhow::Error::new(err).context(format!("could not create {}", path.display())))
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_editor_is_left_alone() {
        let editor = parse_editor("vim").expect("editor");
        assert_eq!(editor.program, "vim");
        assert!(editor.arguments.is_empty());
    }

    #[test]
    fn arguments_are_preserved() {
        let editor = parse_editor("emacs -nw").expect("editor");
        assert_eq!(editor.program, "emacs");
        assert_eq!(editor.arguments, vec!["-nw".to_string()]);
    }

    #[test]
    fn gui_editors_are_made_to_wait() {
        // Without this the session ends before the window opens.
        for command in ["code", "subl", "zed", "codium", "code-insiders"] {
            let editor = parse_editor(command).expect("editor");
            assert_eq!(
                editor.arguments,
                vec!["--wait".to_string()],
                "{command} was not made to wait"
            );
        }
    }

    #[test]
    fn a_wait_flag_is_not_added_twice() {
        let editor = parse_editor("code --wait").expect("editor");
        assert_eq!(editor.arguments, vec!["--wait".to_string()]);
        let editor = parse_editor("code -w").expect("editor");
        assert_eq!(editor.arguments, vec!["-w".to_string()]);
    }

    #[test]
    fn a_full_path_to_a_gui_editor_is_recognised() {
        let editor = parse_editor("/usr/local/bin/code").expect("editor");
        assert_eq!(editor.arguments, vec!["--wait".to_string()]);
    }

    #[test]
    fn an_unknown_editor_gets_no_flags() {
        let editor = parse_editor("my-editor").expect("editor");
        assert!(editor.arguments.is_empty());
    }

    #[test]
    fn an_empty_command_is_no_editor() {
        assert!(parse_editor("").is_none());
        assert!(parse_editor("   ").is_none());
    }

    #[test]
    fn the_scratch_file_keeps_the_documents_extension() {
        // So the editor highlights it as Markdown rather than as nothing.
        assert_eq!(scratch_suffix("Private/notes.md.age", ".age"), "-notes.md");
        assert_eq!(
            scratch_suffix("Private/a/b/report.pdf.age", ".age"),
            "-report.pdf"
        );
        assert_eq!(scratch_suffix("notes.md", ".age"), "-notes.md");
    }

    #[test]
    fn a_lock_is_exclusive_and_released_on_drop() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path();

        let first = match Lock::acquire(root, "Private/notes.md.age") {
            Ok(Ok(lock)) => lock,
            other => panic!("expected a lock, got {other:?}"),
        };
        let path = first.path.clone();
        assert!(path.is_file());

        match Lock::acquire(root, "Private/notes.md.age") {
            Ok(Err(message)) => {
                assert!(message.contains("already open"), "{message}");
                assert!(message.contains("pid"), "{message}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }

        // A different document is not blocked.
        assert!(matches!(
            Lock::acquire(root, "Private/other.md.age"),
            Ok(Ok(_))
        ));

        drop(first);
        assert!(!path.exists(), "the lock outlived its session");
    }

    #[test]
    fn a_lock_lives_outside_every_vault() {
        // A lock file inside an encrypted vault would be plaintext in the
        // one place invariant 1 forbids.
        let temp = tempfile::tempdir().expect("temp");
        let lock = match Lock::acquire(temp.path(), "Private/notes.md.age") {
            Ok(Ok(lock)) => lock,
            other => panic!("{other:?}"),
        };
        let relative = lock
            .path
            .strip_prefix(temp.path())
            .expect("inside the repository");
        assert!(
            relative.starts_with(".fjord/local"),
            "a lock must live under /.fjord/local/, not at {}",
            relative.display()
        );
    }
}

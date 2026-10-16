//! Git, confined to one file.
//!
//! Every `git` invocation in this toolchain happens here. v1 shells out to
//! the `git` binary the user already has, which sidesteps choosing between
//! `git2` and `gix` and costs nothing: the operations needed are a handful
//! of plumbing commands.
//!
//! When a client needs git without a binary — the desktop app, the web
//! build — this is the surface to lift into a trait and reimplement with
//! `gix`. That is why `Command::new("git")` appears in exactly one function
//! below: nothing else in the codebase knows how git is reached.

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::process::Command;

/// The default branch a new repository gets.
///
/// Set explicitly rather than inherited from `init.defaultBranch`, so that
/// a repository Fjord creates has the same branch name everywhere and the
/// `git push -u origin main` in the README is correct.
pub const DEFAULT_BRANCH: &str = "main";

/// Git operations against one working tree.
#[derive(Debug, Clone)]
pub struct Git {
    root: PathBuf,
}

impl Git {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Whether a usable `git` is on `PATH`.
    ///
    /// Checked before scaffolding, so a missing git is reported before any
    /// files are written rather than after.
    pub fn is_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// `git init -b <branch>`.
    pub fn init(&self, branch: &str) -> Result<()> {
        self.run(&["init", "-b", branch])
            .map(drop)
            .context("could not initialise a git repository")
    }

    /// Whether the working tree is already inside a git repository.
    pub fn is_repository(&self) -> bool {
        self.run(&["rev-parse", "--git-dir"]).is_ok()
    }

    /// `git add -A`.
    ///
    /// Respects every `.gitignore`, including an encrypted vault's §6.5
    /// plaintext guard — which is the point: the guard must be able to keep
    /// a stray decrypted file out of a commit Fjord itself makes.
    pub fn add_all(&self) -> Result<()> {
        self.run(&["add", "-A"])
            .map(drop)
            .context("could not stage files")
    }

    /// `git commit -m <message>`.
    pub fn commit(&self, message: &str) -> Result<()> {
        self.run(&["commit", "-m", message])
            .map(drop)
            .context("could not create the first commit")
    }

    /// The only place a git subprocess is spawned.
    fn run(&self, arguments: &[&str]) -> Result<String> {
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(arguments)
            .output()
            .with_context(|| format!("could not run `git {}`", arguments.join(" ")))?;

        if !output.status.success() {
            // git's own message is far more useful than anything this layer
            // could synthesise — "please tell me who you are", for one.
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = stderr.trim();
            if message.is_empty() {
                bail!("`git {}` failed", arguments.join(" "));
            }
            bail!("`git {}` failed: {message}", arguments.join(" "));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

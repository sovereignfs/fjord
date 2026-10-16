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

    /// `git add -- <path>`, for one file.
    ///
    /// `--` so a path that looks like an option, or like a revision, is
    /// still treated as a path.
    pub fn add_path(&self, relative: &str) -> Result<()> {
        self.run(&["add", "--", relative])
            .map(drop)
            .with_context(|| format!("could not stage {relative}"))
    }

    /// `git commit -m <message>`.
    pub fn commit(&self, message: &str) -> Result<()> {
        self.run(&["commit", "-m", message])
            .map(drop)
            .context("could not create the first commit")
    }

    /// The branch HEAD is on, or `None` when it is detached or there are
    /// no commits yet.
    pub fn current_branch(&self) -> Result<Option<String>> {
        let name = self.run_line(&["rev-parse", "--abbrev-ref", "HEAD"])?;
        if name.is_empty() || name == "HEAD" {
            return Ok(None);
        }
        Ok(Some(name))
    }

    /// Paths with uncommitted changes, staged or not.
    pub fn changed_paths(&self) -> Result<Vec<String>> {
        let output = self.run(&["status", "--porcelain"])?;
        Ok(output
            .lines()
            // Two status columns, then the path. Taken from column 2 and
            // trimmed rather than from a fixed offset, so ` M`, `M `, `??`
            // and `R ` all yield the same thing.
            .filter_map(|line| line.get(2..).map(|path| path.trim_start().to_string()))
            .filter(|path| !path.is_empty())
            .collect())
    }

    /// Paths left conflicted by a merge. Spec §9.1.
    pub fn unmerged_paths(&self) -> Result<Vec<String>> {
        let output = self.run(&["diff", "--name-only", "--diff-filter=U"])?;
        Ok(output
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }

    /// Commits ahead of and behind the tracked branch, or `None` when no
    /// upstream is configured.
    pub fn ahead_behind(&self) -> Result<Option<(usize, usize)>> {
        let counts = match self.run_line(&["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
            Ok(counts) => counts,
            // No upstream, which is the ordinary state of a repository that
            // has not been pushed yet.
            Err(_) => return Ok(None),
        };
        let mut fields = counts.split_whitespace();
        let behind = fields.next().and_then(|value| value.parse().ok());
        let ahead = fields.next().and_then(|value| value.parse().ok());
        match (ahead, behind) {
            (Some(ahead), Some(behind)) => Ok(Some((ahead, behind))),
            _ => Ok(None),
        }
    }

    /// A git command whose output is a single value, trimmed.
    fn run_line(&self, arguments: &[&str]) -> Result<String> {
        Ok(self.run(arguments)?.trim().to_string())
    }

    /// The only place a git subprocess is spawned.
    ///
    /// Returns stdout **untrimmed**. `git status --porcelain` encodes
    /// meaning in a leading space, so trimming here once silently ate the
    /// first character of the first changed path.
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

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

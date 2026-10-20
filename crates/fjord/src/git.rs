// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
use std::path::{Path, PathBuf};
use std::process::Command;

/// What came of a merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    /// Nothing to pull.
    UpToDate,
    /// Merged, or fast-forwarded, with nothing left to resolve.
    Clean,
    /// Paths git would not merge, left for Fjord to resolve by decrypting.
    Conflicted(Vec<String>),
}

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

    /// `git add -- <paths>`.
    pub fn add_paths(&self, paths: &[&str]) -> Result<()> {
        let mut arguments = vec!["add", "--"];
        arguments.extend(paths);
        self.run(&arguments)
            .map(drop)
            .with_context(|| format!("could not stage {}", paths.join(", ")))
    }

    /// Commit **only** `paths`, whatever else is staged.
    ///
    /// `git commit` with no pathspec commits the whole index, so anything the
    /// user had already staged — an unrelated edit, a half-finished change —
    /// would be swept into a commit whose message says it adds a vault. With
    /// a pathspec git commits just those paths and leaves the rest of the
    /// index exactly as it found it.
    pub fn commit_paths(&self, message: &str, paths: &[&str]) -> Result<()> {
        let mut arguments = vec!["commit", "-m", message, "--"];
        arguments.extend(paths);
        self.run(&arguments)
            .map(drop)
            .context("could not create the commit")
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

    /// Fetch from the default remote.
    pub fn fetch(&self) -> Result<()> {
        self.run(&["fetch", "--quiet"]).map(drop)
    }

    /// The tracked upstream ref, or `None` when none is configured.
    pub fn upstream(&self) -> Option<String> {
        self.run_line(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .ok()
            .filter(|name| !name.is_empty())
    }

    /// Configured remotes, in git's order.
    pub fn remotes(&self) -> Vec<String> {
        self.run(&["remote"])
            .map(|output| {
                output
                    .lines()
                    .map(|line| line.trim().to_string())
                    .filter(|line| !line.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether a ref exists, such as `origin/main`.
    pub fn ref_exists(&self, reference: &str) -> bool {
        self.run_line(&["rev-parse", "--verify", "--quiet", reference])
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    }

    /// `git push --set-upstream`, which is what a first push needs.
    pub fn push_set_upstream(&self, remote: &str, branch: &str) -> Result<()> {
        self.run(&["push", "--set-upstream", remote, branch])
            .map(drop)
            .with_context(|| format!("could not push to {remote}"))
    }

    /// The commit HEAD points at.
    pub fn head(&self) -> Result<String> {
        self.run_line(&["rev-parse", "HEAD"])
    }

    /// How many commits are in `range`, e.g. `old..new`.
    pub fn count(&self, range: &str) -> usize {
        self.run_line(&["rev-list", "--count", range])
            .ok()
            .and_then(|count| count.parse().ok())
            .unwrap_or(0)
    }

    /// Whether anything is uncommitted.
    pub fn is_dirty(&self) -> Result<bool> {
        Ok(!self.changed_paths()?.is_empty())
    }

    /// Merge `reference` into HEAD without committing, so that conflicts
    /// can be resolved before anything is recorded.
    ///
    /// `--no-ff` is deliberately absent: a fast-forward is the common case
    /// and needs no merge commit.
    pub fn merge_no_commit(&self, reference: &str) -> Result<MergeOutcome> {
        // `.gitattributes` sets `*.age -merge`, so git leaves a conflicting
        // payload for us rather than attempting a textual merge of
        // ciphertext (§9, §9.1).
        match self.run(&["merge", "--no-commit", "--no-edit", reference]) {
            Ok(output) => {
                if output.contains("Already up to date") {
                    Ok(MergeOutcome::UpToDate)
                } else {
                    Ok(MergeOutcome::Clean)
                }
            }
            // A conflict is a non-zero exit, which is not an error here.
            Err(_) => {
                let unmerged = self.unmerged_paths()?;
                if unmerged.is_empty() {
                    Err(anyhow::anyhow!(
                        "the merge failed and left no conflicts to resolve"
                    ))
                } else {
                    Ok(MergeOutcome::Conflicted(unmerged))
                }
            }
        }
    }

    /// One stage of a conflicted path from the index: 1 is the merge base,
    /// 2 is ours, 3 is theirs. Spec §9.1.
    ///
    /// `None` when that stage does not exist — a file added on both sides
    /// has no base, and a delete/modify conflict is missing one side.
    /// Returned as raw bytes, because a stage of an encrypted payload is
    /// ciphertext.
    pub fn stage(&self, stage: u8, path: &str) -> Option<Vec<u8>> {
        self.run_bytes(&["show", &format!(":{stage}:{path}")]).ok()
    }

    /// `git merge-file`: a real three-way merge, by the same algorithm git
    /// itself uses.
    ///
    /// The result is written into `ours`. Returns whether it merged
    /// cleanly; conflicts are reported by a positive exit status, which is
    /// not an error.
    pub fn merge_file(&self, ours: &Path, base: &Path, theirs: &Path) -> Result<bool> {
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(["merge-file", "-L", "ours", "-L", "base", "-L", "theirs"])
            .arg(ours)
            .arg(base)
            .arg(theirs)
            .output()
            .context("could not run `git merge-file`")?;

        match output.status.code() {
            Some(0) => Ok(true),
            // A positive code is the number of conflict hunks.
            Some(code) if code > 0 && code < 128 => Ok(false),
            _ => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                bail!("`git merge-file` failed: {}", stderr.trim())
            }
        }
    }

    /// Record the merge in progress.
    pub fn commit_merge(&self, message: &str) -> Result<()> {
        self.run(&["commit", "--no-edit", "-m", message])
            .map(drop)
            .context("could not commit the merge")
    }

    /// `git push`.
    pub fn push(&self) -> Result<()> {
        self.run(&["push"]).map(drop).context("could not push")
    }

    /// Accept a deletion that both sides agreed on.
    pub fn remove_path(&self, relative: &str) -> Result<()> {
        self.run(&["rm", "--quiet", "--", relative])
            .map(drop)
            .with_context(|| format!("could not remove {relative}"))
    }

    /// Whether a merge is recorded but not yet committed.
    pub fn merge_in_progress(&self) -> bool {
        self.run_line(&["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])
            .map(|head| !head.is_empty())
            .unwrap_or(false)
    }

    /// A git command whose output is raw bytes.
    ///
    /// Required wherever the output is content rather than text: a stage of
    /// an encrypted payload is ciphertext, and passing it through
    /// `from_utf8_lossy` would replace every invalid byte with U+FFFD and
    /// hand back something that is no longer an age file.
    fn run_bytes(&self, arguments: &[&str]) -> Result<Vec<u8>> {
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(arguments)
            .output()
            .with_context(|| format!("could not run `git {}`", arguments.join(" ")))?;
        if !output.status.success() {
            bail!("`git {}` failed", arguments.join(" "));
        }
        Ok(output.stdout)
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

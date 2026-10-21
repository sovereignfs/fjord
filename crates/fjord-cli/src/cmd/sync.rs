// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord sync` — pull, resolve, push. Spec §9.1.
//!
//! This cannot be `git pull`, and the reason is worth stating precisely:
//! Git cannot merge ciphertext, and §9.1 says clients MUST NOT ask it to. A
//! textual three-way merge of two age payloads produces a file that is
//! neither side and decrypts to nothing.
//!
//! So `.gitattributes` sets `*.age -merge` (§9), which makes Git stop at a
//! conflicting payload instead of mangling it, and this command resolves it
//! the way §9.1 requires: **decrypt both sides and their merge base, merge
//! the plaintext, re-encrypt the result.** Plaintext vaults take the same
//! path, as §9.1 recommends, so there is one implementation to get right
//! rather than two.
//!
//! # When a merge cannot complete
//!
//! Invariant 5 and §9.1: **neither side is ever discarded.** One is kept in
//! place and the other written alongside it as a new Doc with a fresh `id`
//! — the spec's own remedy, and the fresh id is not cosmetic, since two
//! files sharing one id would resolve a conflict by creating an `E401`.
//!
//! A conflict means the command exits 1 and does **not** push: spreading a
//! half-resolved state to everyone else is not an improvement.

use crate::cli::{ExitCode, GlobalArgs, SyncArgs};
use crate::cmd::{ensure_writable, find_root, plural, Style};
use crate::git::{Git, MergeOutcome};
use anyhow::{Context, Result};
use fjord_core::crypto::Identities;
use fjord_core::vault::{self, Vault};
use fjord_core::{crypto, doc, scalar};
use std::io::Write;
use std::path::Path;
use zeroize::Zeroizing;

pub fn run(args: &SyncArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }

    let git = Git::new(&root);
    if !git.is_repository() {
        anyhow::bail!(
            "{} is not a git repository, so there is nothing to sync with. \
             `fjord init` creates one",
            root.display()
        );
    }

    // Before anything is staged: `sync` commits the whole working tree, and
    // a vault with plaintext in it, or without the guard that keeps plaintext
    // out of a commit, is not something to commit blind. Spec §6.5.
    if let Some(code) = crate::cmd::guard::ensure_nothing_in_the_clear(&root)? {
        return Ok(code);
    }

    let style = Style::detect();
    let mut committed_locally = false;

    // Local work first: a merge into a dirty tree is refused by git, and
    // committing is what the user meant by "sync" anyway.
    if git
        .is_dirty()
        .context("could not read the repository's status")?
    {
        git.add_all()?;
        let message = match &args.message {
            Some(message) => message.clone(),
            None => "Sync local changes".to_string(),
        };
        git.commit(&message)?;
        committed_locally = true;
        if !global.quiet {
            println!("  {} {message}", style.dim("committed"));
        }
    }

    // What to sync against. A configured upstream is the normal case; a
    // repository where `git remote add` has been run but nothing pushed
    // yet has none, and reporting "no remote" there would be true,
    // unhelpful, and indistinguishable from having no remote at all.
    let tracking = match resolve_tracking(&git) {
        Ok(tracking) => tracking,
        Err(message) => return Ok(crate::cmd::usage(message)),
    };
    let upstream = tracking.reference.clone();
    let before = git.head()?;
    let mut conflicts = Vec::new();
    let mut resolved = Vec::new();

    if let Some(upstream) = &upstream {
        git.fetch().context("could not fetch from the remote")?;

        if !git.ref_exists(upstream) {
            // The remote exists but carries nothing on this branch yet,
            // which is the state of a repository created before its remote.
            return finish_without_pulling(&git, &tracking, args, global, &style);
        }

        match git.merge_no_commit(upstream)? {
            MergeOutcome::UpToDate => {}
            MergeOutcome::Clean => {
                if git.merge_in_progress() {
                    git.commit_merge("Merge remote changes")?;
                }
            }
            MergeOutcome::Conflicted(paths) => {
                let identities = crate::cmd::load_identities(global).ok();
                for path in &paths {
                    let outcome = resolve(&root, &git, path, identities.as_ref())
                        .with_context(|| format!("could not resolve {path}"))?;
                    match &outcome {
                        Outcome::BothKept { .. } => conflicts.push((path.clone(), outcome)),
                        _ => resolved.push((path.clone(), outcome)),
                    }
                }

                let summary = if conflicts.is_empty() {
                    "Merge remote changes".to_string()
                } else {
                    format!(
                        "Merge remote changes, {} unresolved",
                        plural(conflicts.len(), "conflict", "conflicts")
                    )
                };
                git.commit_merge(&summary)?;
            }
        }
    }

    let pulled = git.count(&format!("{before}..HEAD"));

    if !global.quiet {
        report(&style, &upstream, pulled, &resolved, &conflicts);
    }

    // A conflict is not pushed: everyone else inherits the unresolved state
    // otherwise, and they cannot resolve it for you.
    if !conflicts.is_empty() {
        if !global.quiet {
            println!();
            println!(
                "  {} nothing was pushed. Resolve the documents above, then run \
                 `fjord sync` again.",
                style.warning("held back:")
            );
        }
        return Ok(ExitCode::Problems);
    }

    if args.no_push {
        return Ok(ExitCode::Ok);
    }

    push(&git, &tracking, committed_locally, global, &style)?;
    Ok(ExitCode::Ok)
}

/// Where this repository syncs to.
#[derive(Debug, Clone)]
struct Tracking {
    /// The ref to merge from, if there is one.
    reference: Option<String>,
    /// The remote and branch to push to when no upstream is configured yet.
    first_push: Option<(String, String)>,
}

/// Work out what to sync against.
///
/// A configured upstream wins. Failing that, a single remote and the
/// current branch imply one: `fjord sync` straight after
/// `git remote add origin …` should do what the user plainly meant, and
/// set the upstream on the way so the next one is unambiguous.
fn resolve_tracking(git: &Git) -> std::result::Result<Tracking, String> {
    if let Some(reference) = git.upstream() {
        return Ok(Tracking {
            reference: Some(reference),
            first_push: None,
        });
    }

    let remotes = git.remotes();
    let branch = git.current_branch().ok().flatten();

    match (remotes.len(), branch) {
        (0, _) | (_, None) => Ok(Tracking {
            reference: None,
            first_push: None,
        }),
        (1, Some(branch)) => {
            let remote = remotes[0].clone();
            Ok(Tracking {
                reference: Some(format!("{remote}/{branch}")),
                first_push: Some((remote, branch)),
            })
        }
        (_, Some(branch)) => Err(format!(
            "this repository has {} remotes ({}) and no upstream branch, so there is no \
             one place to sync with. Choose one with `git push -u <remote> {branch}`",
            remotes.len(),
            remotes.join(", ")
        )),
    }
}

/// Push, and report what happened.
fn push(
    git: &Git,
    tracking: &Tracking,
    committed_locally: bool,
    global: &GlobalArgs,
    style: &Style,
) -> Result<()> {
    match (&tracking.reference, &tracking.first_push) {
        (None, _) => {
            if !global.quiet {
                println!(
                    "  {}",
                    style.dim("no remote configured, so nothing was pushed")
                );
            }
        }
        // A first push, which also establishes the upstream.
        (Some(_), Some((remote, branch))) => {
            git.push_set_upstream(remote, branch)?;
            if !global.quiet {
                println!(
                    "  {} to {remote}/{branch} {}",
                    style.good("↑ pushed"),
                    style.dim("(now tracked)")
                );
            }
        }
        (Some(upstream), None) => {
            let ahead = git.count(&format!("{upstream}..HEAD"));
            if ahead == 0 {
                if !global.quiet && !committed_locally {
                    println!("  {}", style.dim("nothing to push"));
                }
            } else {
                git.push()?;
                if !global.quiet {
                    println!(
                        "  {} {}",
                        style.good("↑ pushed"),
                        plural(ahead, "commit", "commits")
                    );
                }
            }
        }
    }
    Ok(())
}

/// The remote carries nothing on this branch yet: nothing to merge, only
/// something to push.
fn finish_without_pulling(
    git: &Git,
    tracking: &Tracking,
    args: &SyncArgs,
    global: &GlobalArgs,
    style: &Style,
) -> Result<ExitCode> {
    if !global.quiet {
        println!(
            "  {}",
            style.dim("the remote has nothing on this branch yet")
        );
    }
    if args.no_push {
        return Ok(ExitCode::Ok);
    }
    push(git, tracking, true, global, style)?;
    Ok(ExitCode::Ok)
}

/// What became of one conflicted path.
#[derive(Debug)]
enum Outcome {
    /// Merged by decrypting both sides and their base.
    Merged,
    /// Unmergeable. Both versions survive on disk. Invariant 5, §9.1.
    BothKept { alongside: String, reason: String },
    /// One side deleted the file and the other changed it. Content cannot
    /// be discarded, so the surviving version stays.
    KeptSurvivor { which: &'static str },
    /// Both sides deleted it, so there is nothing to preserve.
    AcceptedDeletion,
}

fn resolve(root: &Path, git: &Git, path: &str, identities: Option<&Identities>) -> Result<Outcome> {
    let base = git.stage(1, path);
    let ours = git.stage(2, path);
    let theirs = git.stage(3, path);

    match (ours, theirs) {
        // Deleted on both sides: no version to preserve.
        (None, None) => {
            git.remove_path(path)?;
            Ok(Outcome::AcceptedDeletion)
        }
        // Delete/modify. A deletion cannot be "kept" as a file, so keeping
        // the surviving content is the only reading of invariant 5 that
        // preserves anything at all.
        (Some(ours), None) => {
            std::fs::write(root.join(path), &ours)
                .with_context(|| format!("could not write {path}"))?;
            git.add_path(path)?;
            Ok(Outcome::KeptSurvivor { which: "ours" })
        }
        (None, Some(theirs)) => {
            std::fs::write(root.join(path), &theirs)
                .with_context(|| format!("could not write {path}"))?;
            git.add_path(path)?;
            Ok(Outcome::KeptSurvivor { which: "theirs" })
        }
        (Some(ours), Some(theirs)) => merge_both(root, git, path, base, &ours, &theirs, identities),
    }
}

#[allow(clippy::too_many_arguments)]
fn merge_both(
    root: &Path,
    git: &Git,
    path: &str,
    base: Option<Vec<u8>>,
    ours: &[u8],
    theirs: &[u8],
    identities: Option<&Identities>,
) -> Result<Outcome> {
    let vault = vault::containing(root, path).context("could not read the vault")?;
    let encrypted = vault.as_ref().map(Vault::is_encrypted).unwrap_or(false);

    // Decrypt all three sides. §9.1 is explicit that the base is part of
    // this: without it a three-way merge degrades to a two-way one, which
    // reports a conflict for every line either side touched.
    let decrypt = |bytes: &[u8]| -> Option<Zeroizing<Vec<u8>>> {
        if !encrypted {
            return Some(Zeroizing::new(bytes.to_vec()));
        }
        let identities = identities?;
        crypto::decrypt(bytes, identities).ok()
    };

    let ours_text = decrypt(ours);
    let theirs_text = decrypt(theirs);
    let base_text = match &base {
        Some(base) => decrypt(base),
        // A file added on both sides has no base. An empty one is correct:
        // every line is then an addition from both sides.
        None => Some(Zeroizing::new(Vec::new())),
    };

    let (ours_text, theirs_text, base_text) = match (ours_text, theirs_text, base_text) {
        (Some(ours), Some(theirs), Some(base)) => (ours, theirs, base),
        _ => {
            return keep_both(
                root,
                git,
                path,
                ours,
                theirs,
                vault.as_ref(),
                identities,
                "no identity of yours decrypts this document",
            )
        }
    };

    // `git merge-file` merges text. A PDF or a spreadsheet has no lines to
    // merge, and pretending otherwise would corrupt it.
    if std::str::from_utf8(&ours_text).is_err() || std::str::from_utf8(&theirs_text).is_err() {
        return keep_both(
            root,
            git,
            path,
            ours,
            theirs,
            vault.as_ref(),
            identities,
            "not a text document, so there are no lines to merge",
        );
    }

    // Plaintext lives outside the repository, as everywhere else.
    let workspace = tempfile::tempdir().context("could not create a merge workspace")?;
    let ours_file = workspace.path().join("ours");
    let base_file = workspace.path().join("base");
    let theirs_file = workspace.path().join("theirs");
    write_private(&ours_file, &ours_text)?;
    write_private(&base_file, &base_text)?;
    write_private(&theirs_file, &theirs_text)?;

    let clean = git.merge_file(&ours_file, &base_file, &theirs_file)?;
    if !clean {
        return keep_both(
            root,
            git,
            path,
            ours,
            theirs,
            vault.as_ref(),
            identities,
            "both sides changed the same lines",
        );
    }

    // `merge-file` wrote the result into the `ours` file.
    let merged =
        Zeroizing::new(std::fs::read(&ours_file).context("could not read the merged document")?);

    let bytes = match (&vault, encrypted) {
        (Some(vault), true) => {
            let recipients = crypto::parse_recipients(
                &vault
                    .read_recipients()
                    .context("could not read the recipients file")?,
            )?;
            crypto::encrypt(&merged, &recipients, vault.armor())
                .context("could not re-encrypt the merged document")?
        }
        _ => merged.to_vec(),
    };

    std::fs::write(root.join(path), &bytes).with_context(|| format!("could not write {path}"))?;
    git.add_path(path)?;
    Ok(Outcome::Merged)
}

/// Keep ours in place and write theirs alongside it. Spec §9.1,
/// invariant 5.
#[allow(clippy::too_many_arguments)]
fn keep_both(
    root: &Path,
    git: &Git,
    path: &str,
    ours: &[u8],
    theirs: &[u8],
    vault: Option<&Vault>,
    identities: Option<&Identities>,
    reason: &str,
) -> Result<Outcome> {
    // Ours goes back exactly as it was: the merge attempt must leave no
    // trace on the version that was already here.
    std::fs::write(root.join(path), ours).with_context(|| format!("could not restore {path}"))?;
    git.add_path(path)?;

    let id = scalar::new_ulid();
    let alongside = alongside_path(path, vault, &id);

    // Theirs becomes a new Doc with a fresh id, so that preserving it does
    // not create a duplicate id (E401). When the vault is encrypted and we
    // cannot decrypt, the ciphertext is kept verbatim instead — still both
    // versions, which is what invariant 5 requires.
    let encrypted = vault.map(Vault::is_encrypted).unwrap_or(false);
    let bytes = match rewritten_theirs(theirs, vault, identities, &id, encrypted) {
        Some(bytes) => bytes,
        None => theirs.to_vec(),
    };

    let destination = root.join(&alongside);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }
    std::fs::write(&destination, &bytes).with_context(|| format!("could not write {alongside}"))?;
    git.add_path(&alongside)?;

    Ok(Outcome::BothKept {
        alongside,
        reason: reason.to_string(),
    })
}

/// Theirs, with a fresh `id` if it is a Doc we can read.
fn rewritten_theirs(
    theirs: &[u8],
    vault: Option<&Vault>,
    identities: Option<&Identities>,
    id: &str,
    encrypted: bool,
) -> Option<Vec<u8>> {
    let plaintext = if encrypted {
        crypto::decrypt(theirs, identities?).ok()?
    } else {
        Zeroizing::new(theirs.to_vec())
    };

    let text = std::str::from_utf8(&plaintext).ok()?;
    let rewritten = doc::with_fresh_id(text, id)?;

    if !encrypted {
        return Some(rewritten.into_bytes());
    }
    let vault = vault?;
    let recipients = crypto::parse_recipients(&vault.read_recipients().ok()?).ok()?;
    crypto::encrypt(rewritten.as_bytes(), &recipients, vault.armor()).ok()
}

/// Where the other side is written: beside the original, under a name that
/// says what it is.
fn alongside_path(path: &str, vault: Option<&Vault>, id: &str) -> String {
    let suffix = vault
        .filter(|vault| vault.is_encrypted())
        .map(|vault| vault.suffix())
        .unwrap_or_default();

    let logical = path.strip_suffix(&suffix).unwrap_or(path);
    let short = &id[id.len().saturating_sub(8)..];

    match logical.rsplit_once('.') {
        Some((stem, extension)) => format!("{stem}.conflict-{short}.{extension}{suffix}"),
        None => format!("{logical}.conflict-{short}{suffix}"),
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("could not create {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

fn report(
    style: &Style,
    upstream: &Option<String>,
    pulled: usize,
    resolved: &[(String, Outcome)],
    conflicts: &[(String, Outcome)],
) {
    if upstream.is_none() {
        println!(
            "  {}",
            style.dim("no remote configured, so nothing was pulled")
        );
    } else if pulled == 0 {
        println!("  {}", style.dim("already up to date"));
    } else {
        println!(
            "  {} {}",
            style.good("↓ pulled"),
            plural(pulled, "commit", "commits")
        );
    }

    for (path, outcome) in resolved {
        match outcome {
            Outcome::Merged => println!(
                "  {} {path} {}",
                style.warning("⚠"),
                style.dim("changed on both sides — merged")
            ),
            Outcome::KeptSurvivor { which } => println!(
                "  {} {path} {}",
                style.warning("⚠"),
                style.dim(&format!(
                    "deleted on one side, changed on the other — kept {which}"
                ))
            ),
            Outcome::AcceptedDeletion => println!(
                "  {} {path} {}",
                style.dim("−"),
                style.dim("deleted on both sides")
            ),
            Outcome::BothKept { .. } => {}
        }
    }

    for (path, outcome) in conflicts {
        if let Outcome::BothKept { alongside, reason } = outcome {
            println!();
            println!("  {} {path}", style.error("✗ conflict"));
            println!("    {}", style.dim(reason));
            println!("    your version is unchanged at {path}");
            println!("    theirs is kept alongside it at {alongside}");
        }
    }
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord encrypt <vault> --permanent` and `fjord decrypt <vault> --permanent` — make a vault encrypted, or plaintext again
//! (RFC 0003, spec §6.7). Without `--permanent` those two commands are the checkout (spec §6.6, [`crate::cmd::checkout`]).
//!
//! Both are built on the checkout (spec §6.6) and never write plaintext into an encrypted vault any other way:
//!
//! - **encrypt** makes the vault's manifest an encrypted one's, begins a checkout with no entries (the files are
//!   plaintext nobody has encrypted yet) and checks it in, which encrypts every file, proves each payload decrypts to
//!   what it was made from, and only then removes the plaintext.
//! - **decrypt** begins an ordinary checkout, then makes the vault plaintext: the manifest first, then the payloads,
//!   then the recipients file and the guard, and the record last. Plaintext is never removed, so an interruption
//!   leaves the vault readable and the checkout's record in place.

use crate::cli::{DecryptArgs, EncryptArgs, ExitCode, GlobalArgs};
use crate::cmd::{
    checkout, ensure_writable, find_root, load_identities, plural, usage, write_atomically, Style,
};
use crate::git::Git;
use anyhow::{Context, Result};
use fjord_core::vault::Vault;
use fjord_core::{crypto, scaffold};
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

/// What a command was asked to do, apart from the vault.
pub struct Options<'a> {
    pub recipients: &'a [String],
    pub yes: bool,
    pub commit: bool,
}

fn vault_of(root: &Path, name: &str) -> Result<std::result::Result<Vault, ExitCode>> {
    let relative = name.trim_end_matches('/');
    match checkout::vault_named(root, relative)? {
        Some(vault) => Ok(Ok(vault)),
        None => Ok(Err(usage(format!(
            "there is no vault named {relative}. `fjord vault list` shows the repository's vaults"
        )))),
    }
}

/// Ask before something that cannot be taken back from the history. With `--no-input` or no terminal, a prompt is a
/// usage error and never a hang.
fn confirm(question: &[&str], yes: bool, global: &GlobalArgs) -> Result<bool> {
    if yes {
        return Ok(true);
    }
    if global.no_input || !std::io::stdin().is_terminal() {
        anyhow::bail!("this needs confirmation, and there is no one to ask. Pass --yes");
    }
    let mut stderr = std::io::stderr();
    for line in question {
        writeln!(stderr, "{line}")?;
    }
    write!(stderr, "Continue? [y/N]: ")?;
    stderr.flush()?;
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line)? == 0 {
        return Ok(false);
    }
    Ok(matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
}

/// The recipients to encrypt to: the keys given, else the public key of the identity that will check the result.
fn recipients_for(
    options: &Options<'_>,
    global: &GlobalArgs,
) -> Result<std::result::Result<Vec<String>, ExitCode>> {
    let mut chosen: Vec<String> = Vec::new();
    for key in options.recipients {
        if let Err(reason) = crypto::check_recipient(key) {
            return Ok(Err(usage(format!(
                "{key} is not a usable recipient: {reason}"
            ))));
        }
        let key = key.trim().to_string();
        if !chosen.contains(&key) {
            chosen.push(key);
        }
    }
    if !chosen.is_empty() {
        return Ok(Ok(chosen));
    }
    let path = match &global.identity {
        Some(path) if path.as_os_str() == "-" => {
            return Ok(Err(usage(
                "an identity read from stdin cannot also say whom to encrypt to. Name a recipient with --recipient <public-key>",
            )))
        }
        Some(path) => path.clone(),
        None => crate::cmd::default_identity_path()?,
    };
    if !path.exists() {
        return Ok(Err(usage(format!(
            "there is no one to encrypt to, and no identity at {}. Generate one with `fjord key new`, or name a recipient with --recipient <public-key>",
            path.display()
        ))));
    }
    let text = crate::cmd::read_identity(&path)?;
    let key = crypto::recipient_of(&text)
        .with_context(|| format!("{} holds no usable secret key", path.display()))?;
    Ok(Ok(vec![key]))
}

fn is_site(root: &Path) -> bool {
    std::fs::read(root.join(fjord_core::REPOSITORY_MANIFEST))
        .ok()
        .and_then(|bytes| fjord_core::manifest::Manifest::parse(&bytes).ok())
        .map(|manifest| manifest.presented_kind().as_str() == "ssg")
        .unwrap_or(false)
}

fn directory_of(root: &Path, vault: &Vault) -> PathBuf {
    root.join(&vault.directory)
}

// --- vault encrypt ----------------------------------------------------------

pub fn encrypt(name: &str, options: &Options<'_>, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }
    let vault = match vault_of(&root, name) {
        Ok(Ok(vault)) => vault,
        Ok(Err(code)) => return Ok(code),
        Err(error) => return Err(error),
    };
    if vault.is_encrypted() {
        return Ok(usage(format!(
            "the {0} vault is already encrypted. `fjord key add` adds a recipient, `fjord rekey {0}` re-encrypts it to the current ones, and `fjord decrypt {0}` decrypts it to work on",
            vault.directory
        )));
    }
    if is_site(&root) {
        return Ok(usage(
            "a site's content is never encrypted: it is published (spec §3.1)",
        ));
    }
    if checkout::find(&root, &vault.directory)?.is_some() {
        return Ok(usage(format!(
            "the {} vault has a checkout in progress",
            vault.directory
        )));
    }
    if options.commit {
        if let Some(code) = crate::cmd::guard::ensure_nothing_in_the_clear(&root)? {
            return Ok(code);
        }
        if !Git::new(&root).is_repository() {
            return Ok(usage("--commit needs a git repository"));
        }
    }

    let recipients = match recipients_for(options, global)? {
        Ok(recipients) => recipients,
        Err(code) => return Ok(code),
    };
    // The identity is needed to prove each payload decrypts before any plaintext is removed (§6.6 (8)). Checked now, so a
    // vault is not converted by a person who could not finish converting it.
    load_identities(global)?;

    let directory = directory_of(&root, &vault);
    let manifest_path = directory.join(fjord_core::VAULT_MANIFEST);
    let manifest = std::fs::read(&manifest_path).context("could not read the vault's manifest")?;
    let plan = match scaffold::plan_encrypt_vault(&manifest, &recipients) {
        Ok(plan) => plan,
        Err(error) => return Ok(usage(format!("{error:?}"))),
    };
    for file in &plan.files {
        if directory.join(&file.path).exists() {
            return Ok(usage(format!(
                "{}/{} is already there, and is not ours to replace. Move it aside, then run this again",
                vault.directory, file.path
            )));
        }
    }

    let documents = vault
        .contents()
        .with_context(|| format!("could not read the {} vault", vault.directory))?
        .len();
    if !confirm(
        &[
            &format!(
                "Encrypt {} in {} to {}?",
                plural(documents, "file", "files"),
                vault.directory,
                plural(recipients.len(), "recipient", "recipients")
            ),
            "The files are replaced by encrypted ones, and their names stay readable.",
            "Anything already committed stays in the repository's history in the clear: encrypting does not unpublish it.",
        ],
        options.yes,
        global,
    )? {
        println!("  nothing was changed");
        return Ok(ExitCode::Ok);
    }

    // The record first, then the vault's new files and, last, its manifest: from the manifest on, the vault is an encrypted one
    // with a checkout, which is what the plaintext in it is allowed to be (§6.6).
    checkout::begin_adopted(&root, &vault.directory)?;
    let written = (|| -> Result<()> {
        for file in &plan.files {
            std::fs::write(directory.join(&file.path), &file.contents)
                .with_context(|| format!("could not write {}", file.path))?;
        }
        write_atomically(&manifest_path, plan.manifest.as_bytes())
            .context("could not write the vault's manifest")
    })();
    if let Err(error) = written {
        for file in &plan.files {
            let _ = std::fs::remove_file(directory.join(&file.path));
        }
        checkout::abandon_adopted(&root, &vault.directory);
        return Err(error);
    }

    let converted = match vault_of(&root, name)? {
        Ok(vault) => vault,
        Err(code) => return Ok(code),
    };
    let quiet = GlobalArgs {
        repo: global.repo.clone(),
        identity: global.identity.clone(),
        no_input: global.no_input,
        json: false,
        quiet: true,
    };
    let args = EncryptArgs {
        path: PathBuf::from(&converted.directory),
        keep: false,
        dry_run: false,
        yes: true,
        discard: false,
        permanent: false,
        recipient: Vec::new(),
        commit: false,
    };
    let code = checkout::encrypt(&root, &converted, &args, &quiet)?;
    if !matches!(code, ExitCode::Ok) {
        eprintln!(
            "  the {0} vault is now an encrypted vault with its files still in the clear, and no commit will be made until they are encrypted. Finish with `fjord encrypt {0}`",
            converted.directory
        );
        return Ok(code);
    }

    let mut message = None;
    if options.commit {
        message = Some(commit(&root, &converted.directory, "Encrypt vault")?);
    }

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {}  {}",
            style.good("encrypted"),
            converted.directory,
            style.dim(&format!(
                "{} · {}",
                plural(documents, "file", "files"),
                plural(recipients.len(), "recipient", "recipients")
            ))
        );
        if let Some(message) = message {
            println!("  {} {message}", style.dim("committed"));
        } else {
            println!(
                "  {}",
                style.dim(&format!(
                    "to edit it as plaintext: `fjord decrypt {0}`, then `fjord encrypt {0}` when done; or `fjord open <file>`",
                    converted.directory
                ))
            );
        }
    }
    Ok(ExitCode::Ok)
}

// --- vault decrypt ----------------------------------------------------------

pub fn decrypt(name: &str, options: &Options<'_>, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    if let Some(code) = ensure_writable(&root)? {
        return Ok(code);
    }
    let vault = match vault_of(&root, name) {
        Ok(Ok(vault)) => vault,
        Ok(Err(code)) => return Ok(code),
        Err(error) => return Err(error),
    };
    if !vault.is_encrypted() {
        return Ok(usage(format!(
            "the {} vault is not encrypted, so its files are already readable",
            vault.directory
        )));
    }
    if checkout::find(&root, &vault.directory)?.is_some() {
        return Ok(usage(format!(
            "the {0} vault is checked out. `fjord encrypt {0}` checks it back in first, or `fjord encrypt {0} --discard` throws the decrypted copies away",
            vault.directory
        )));
    }
    if options.commit {
        if let Some(code) = crate::cmd::guard::ensure_nothing_in_the_clear(&root)? {
            return Ok(code);
        }
        if !Git::new(&root).is_repository() {
            return Ok(usage("--commit needs a git repository"));
        }
    }
    load_identities(global)?;

    if !confirm(
        &[
            &format!(
                "Make {} a plaintext vault?",
                vault.directory
            ),
            "Every file in it becomes readable by anyone who can read the repository, and, once committed, stays readable in its history.",
            "The encrypted copies are removed. They stay in the repository's history.",
        ],
        options.yes,
        global,
    )? {
        println!("  nothing was changed");
        return Ok(ExitCode::Ok);
    }

    // An ordinary checkout decrypts every document before it writes any, so a failure leaves nothing behind.
    let quiet = GlobalArgs {
        repo: global.repo.clone(),
        identity: global.identity.clone(),
        no_input: global.no_input,
        json: false,
        quiet: true,
    };
    let args = DecryptArgs {
        path: PathBuf::from(&vault.directory),
        out: None,
        permanent: false,
        yes: false,
        commit: false,
    };
    let code = checkout::decrypt(&root, &vault, &args, &quiet)?;
    if !matches!(code, ExitCode::Ok) {
        return Ok(code);
    }
    let record = checkout::find(&root, &vault.directory)?
        .context("the checkout was made, but its record cannot be read")?;

    let directory = directory_of(&root, &vault);
    let manifest_path = directory.join(fjord_core::VAULT_MANIFEST);
    let manifest = std::fs::read(&manifest_path).context("could not read the vault's manifest")?;
    let plaintext = scaffold::plan_decrypt_vault(&manifest)
        .map_err(|error| anyhow::anyhow!("the manifest cannot be changed: {error:?}"))?;
    let recipients_file = vault.recipients_file();

    // Plaintext is never removed. The manifest first (from here the vault is a plaintext one), then the payloads, whose
    // plaintext is beside them; then the recipients file and the guard, which would keep the plaintext out of a commit; and
    // the record last, because the record is what says plaintext is expected.
    write_atomically(&manifest_path, plaintext.as_bytes())
        .context("could not write the vault's manifest")?;
    for entry in &record.entries {
        let payload = directory.join(&entry.payload);
        std::fs::remove_file(&payload)
            .with_context(|| format!("could not remove {}", payload.display()))?;
        prune_empty(&directory, &payload);
    }
    if let Some(path) = recipients_file {
        let _ = std::fs::remove_file(path);
    }
    let guard = directory.join(".gitignore");
    if std::fs::read_to_string(&guard).is_ok_and(|text| text == scaffold::vault_guard()) {
        std::fs::remove_file(&guard).context("could not remove the plaintext guard")?;
    } else if guard.exists() {
        eprintln!(
            "  {}/.gitignore is not the one an encrypted vault has, so it was left; if it ignores your files, edit it",
            vault.directory
        );
    }
    checkout::abandon_adopted(&root, &vault.directory);

    let mut message = None;
    if options.commit {
        message = Some(commit(&root, &vault.directory, "Decrypt vault")?);
    }

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {}  {}",
            style.good("decrypted"),
            vault.directory,
            style.dim(&format!(
                "{} · now plaintext",
                plural(record.entries.len(), "file", "files")
            ))
        );
        match message {
            Some(message) => println!("  {} {message}", style.dim("committed")),
            None => println!(
                "  {}",
                style.dim("nothing is committed: review it with `git status`, then commit")
            ),
        }
    }
    Ok(ExitCode::Ok)
}

/// Remove the directories that taking `removed` away left empty, up to but not including the vault's own.
fn prune_empty(vault: &Path, removed: &Path) {
    let mut current = removed.parent().map(Path::to_path_buf);
    while let Some(directory) = current {
        if directory == vault || !directory.starts_with(vault) {
            break;
        }
        if std::fs::remove_dir(&directory).is_err() {
            break;
        }
        current = directory.parent().map(Path::to_path_buf);
    }
}

/// Commit the vault, and what its conversion changed outside it, and nothing else. Spec §9: an encrypted vault's payloads are
/// never merged, so the repository's `.gitattributes` has the guard before they are committed.
fn commit(root: &Path, directory: &str, verb: &str) -> Result<String> {
    let git = Git::new(root);
    let mut paths: Vec<String> = vec![directory.to_string()];
    let attributes = root.join(".gitattributes");
    let text = std::fs::read_to_string(&attributes).ok();
    if verb.starts_with("Encrypt") {
        if let Some(next) = scaffold::merge_guard_added(text.as_deref()) {
            std::fs::write(&attributes, next).context("could not write .gitattributes")?;
            paths.push(".gitattributes".to_string());
        }
    }
    let references: Vec<&str> = paths.iter().map(String::as_str).collect();
    let message = format!("{verb} {directory}");
    git.add_paths(&references)
        .and_then(|()| git.commit_paths(&message, &references))
        .with_context(|| {
            format!(
                "the {directory} vault was converted, but could not be committed. Review it with `git status`, then commit it yourself"
            )
        })?;
    Ok(message)
}

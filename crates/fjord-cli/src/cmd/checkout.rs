// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord decrypt <vault>` and `fjord encrypt <vault>`: a checkout. Spec §6.6.
//!
//! Editing an encrypted vault one document at a time is slow, and editors
//! and note applications expect the files to sit where they belong. So at
//! the user's explicit request a vault's documents are decrypted **in
//! place**, beside their payloads (`notes.md.age` → `notes.md`), and checked
//! back in when the work is done.
//!
//! This is the one exception to invariant 1, and everything here exists to
//! keep it a *bounded* exception:
//!
//! - it is never a side effect: only `fjord decrypt <vault>` starts one;
//! - the vault's §6.5 guard `.gitignore` must already be intact, and the
//!   record of the checkout must itself be ignored by git;
//! - the record is written **before** the first plaintext file, so a crash
//!   leaves a state that is recorded rather than a stray file nobody knows
//!   about;
//! - while a record exists every command that commits refuses
//!   ([`crate::cmd::guard`]);
//! - the payloads are never touched until check-in, and check-in changes
//!   nothing at all unless all of it can succeed.
//!
//! # The record
//!
//! `/.fjord/local/checkouts/<digest>.json`, under the directory §2.2 reserves
//! for client machinery and the generated `.gitignore` keeps out of commits.
//! It holds paths and digests, never content. A digest of a short, guessable
//! document would let someone holding the record confirm a guess, so the
//! record is as private as the plaintext it sits beside: local, ignored, and
//! removed when the checkout ends.

use crate::cli::{DecryptArgs, EncryptArgs, ExitCode, GlobalArgs};
use crate::cmd::{ensure_writable, load_identities, plural, shred, usage, write_atomically, Style};
use crate::git::Git;
use anyhow::{Context, Result};
use fjord_core::crypto::{self, Recipients};
use fjord_core::vault::{self, Vault};
use fjord_core::{doc, path as rules, scalar, store};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

const RECORD_VERSION: u32 = 1;

/// How many names to list before summarising.
const NAMED: usize = 12;

// --- The record ------------------------------------------------------------

/// One vault's checkout. Paths are relative to the vault, with forward
/// slashes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    version: u32,
    pub vault: String,
    tool: String,
    created_at: String,
    /// False from the moment the record is written until every decrypted
    /// file exists. A record that is still incomplete means `decrypt` was
    /// interrupted, and a file missing from it was *never written* rather
    /// than deleted — so check-in must not treat its absence as a deletion.
    #[serde(default = "complete_by_default")]
    complete: bool,
    pub entries: Vec<Entry>,
}

fn complete_by_default() -> bool {
    true
}

/// One document: the decrypted file, the payload it came from, and the
/// digests that say whether either has changed since.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub plaintext: String,
    pub payload: String,
    plaintext_hash: String,
    payload_hash: String,
}

fn directory(root: &Path) -> PathBuf {
    root.join(".fjord").join("local").join("checkouts")
}

/// The repository-relative path of a vault's record, for `git check-ignore`.
fn record_relative(vault: &str) -> String {
    format!(".fjord/local/checkouts/{}.json", digest16(vault.as_bytes()))
}

fn digest16(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().as_str()[..16].to_string()
}

fn hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Every checkout in the repository.
///
/// An unreadable record is an error rather than a skip: a record is how the
/// commit guard knows plaintext is expected, and ignoring one it could not
/// read would fail open.
pub fn all(root: &Path) -> Result<Vec<Record>> {
    let directory = directory(root);
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(
                anyhow::Error::new(err).context(format!("could not read {}", directory.display()))
            )
        }
    };

    let mut records = Vec::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("could not read {}", directory.display()))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(&path)
            .with_context(|| format!("could not read the checkout record {}", path.display()))?;
        let record: Record = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "the checkout record {} is not readable. A checkout cannot be ended \
                 without it; if it is damaged, move it aside and run `fjord verify` to \
                 see what is in the clear",
                path.display()
            )
        })?;
        records.push(record);
    }
    records.sort_by(|a, b| a.vault.cmp(&b.vault));
    Ok(records)
}

/// The checkout of one vault, named by its directory.
pub fn find(root: &Path, vault: &str) -> Result<Option<Record>> {
    Ok(all(root)?.into_iter().find(|record| record.vault == vault))
}

fn write_record(root: &Path, record: &Record) -> Result<()> {
    let directory = directory(root);
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("could not create {}", directory.display()))?;
    let path = directory.join(format!("{}.json", digest16(record.vault.as_bytes())));
    let text = serde_json::to_vec_pretty(record).context("could not serialise the record")?;
    write_atomically(&path, &text)
        .with_context(|| format!("could not write the checkout record {}", path.display()))
}

fn remove_record(root: &Path, vault: &str) {
    let path = directory(root).join(format!("{}.json", digest16(vault.as_bytes())));
    let _ = std::fs::remove_file(path);
}

// --- Files that are not documents -------------------------------------------

/// Operating-system and editor droppings. They are not documents: encrypting
/// them would put a `.DS_Store` in the history, and leaving them would leave
/// plaintext in the vault forever. They are removed at check-in.
fn is_noise(relative: &str) -> bool {
    let leaf = relative.rsplit('/').next().unwrap_or(relative);
    matches!(leaf, ".DS_Store" | "Thumbs.db" | "desktop.ini")
        || leaf.starts_with("._")
        || leaf.starts_with(".#")
        || (leaf.starts_with('#') && leaf.ends_with('#'))
        || leaf.ends_with('~')
        || leaf.ends_with(".tmp")
        || leaf.ends_with(".part")
        || leaf.ends_with(".swp")
        || leaf.ends_with(".swo")
}

fn leaf(relative: &str) -> &str {
    relative.rsplit('/').next().unwrap_or(relative)
}

fn parent(relative: &str) -> Option<&str> {
    relative.rsplit_once('/').map(|(directory, _)| directory)
}

fn join(directory: Option<&str>, name: &str) -> String {
    match directory {
        Some(directory) => format!("{directory}/{name}"),
        None => name.to_string(),
    }
}

fn on_disk(vault: &Vault, relative: &str) -> PathBuf {
    let mut path = vault.path.clone();
    for component in relative.split('/') {
        path.push(component);
    }
    path
}

// --- decrypt <vault> --------------------------------------------------------

/// Start a checkout: decrypt every document in `vault` beside its payload.
pub fn decrypt(
    root: &Path,
    vault: &Vault,
    _args: &DecryptArgs,
    global: &GlobalArgs,
) -> Result<ExitCode> {
    if let Some(code) = ensure_writable(root)? {
        return Ok(code);
    }
    if !vault.is_encrypted() {
        return Ok(usage(format!(
            "the {} vault is not encrypted, so there is nothing to decrypt. Its files are \
             already readable",
            vault.directory
        )));
    }
    if find(root, &vault.directory)?.is_some() {
        return Ok(usage(format!(
            "the {0} vault is already checked out. `fjord encrypt {0}` checks it back in, or \
             `fjord encrypt {0} --discard` throws the decrypted copies away",
            vault.directory
        )));
    }

    // §6.6 (2): the guard must be intact and nothing may be in the clear
    // already, or the line between "recorded" and "stray" blurs.
    let findings = crate::cmd::guard::inspect(root, &vault.directory)?;
    if findings.unguarded {
        return Ok(usage(format!(
            "the {} vault has no plaintext-guard .gitignore (E208), and a checkout puts \
             decrypted files where only that file keeps them out of a commit. Restore it \
             first, with `git checkout -- {}/.gitignore`",
            vault.directory, vault.directory
        )));
    }
    if !findings.in_the_clear.is_empty() {
        return Ok(usage(format!(
            "the {} vault already holds {} in the clear ({}). Encrypt {} with `fjord encrypt \
             <path>` or move {} out first, so a checkout starts from a vault with nothing \
             unrecorded in it",
            vault.directory,
            plural(findings.in_the_clear.len(), "file", "files"),
            findings.in_the_clear.join(", "),
            if findings.in_the_clear.len() == 1 {
                "it"
            } else {
                "them"
            },
            if findings.in_the_clear.len() == 1 {
                "it"
            } else {
                "them"
            },
        )));
    }

    // The record must stay out of version control (§6.6 (4)). Older
    // repositories may lack the line that ignores `.fjord/local/`.
    let git = Git::new(root);
    let marker = record_relative(&vault.directory);
    if git.is_repository() && !git.is_ignored(&marker) {
        return Ok(usage(
            "`.fjord/local/` is not ignored by git, so the checkout's record would be \
             committed. Add the line `.fjord/local/` to the repository's .gitignore first",
        ));
    }

    // Validated now rather than at check-in: a vault that could not be
    // written back to should not be decrypted.
    recipients_of(vault)?;
    let identities = load_identities(global)?;

    // §6.6 (3): everything is decrypted before anything is written, so a
    // failure halfway through leaves nothing behind.
    let suffix = vault.suffix();
    let machinery = vault.machinery();
    let mut planned: Vec<(Entry, zeroize::Zeroizing<Vec<u8>>)> = Vec::new();
    let mut seen: BTreeMap<String, String> = BTreeMap::new();

    for content in vault
        .contents()
        .with_context(|| format!("could not read the {} vault", vault.directory))?
        .into_iter()
        .filter(|content| content.is_payload)
    {
        let stored = std::fs::read(on_disk(vault, &content.relative))
            .with_context(|| format!("could not read {}", content.relative))?;
        let loaded = store::load(vault, &stored, Some(&identities))
            .with_context(|| format!("could not decrypt {}", content.relative))?;

        // The container knows the real name where there is one (`id`
        // vaults); otherwise it is the payload's own, suffix removed.
        let plaintext = match &loaded.name {
            Some(name) => join(parent(&content.logical), name),
            None => content.logical.clone(),
        };

        if let Some(problem) = unusable_name(&plaintext, &suffix, &machinery) {
            return Ok(usage(format!(
                "{} would be decrypted to {plaintext:?}, which {problem}. Nothing was \
                 decrypted",
                content.relative
            )));
        }
        if let Some(other) = seen.insert(plaintext.to_lowercase(), content.relative.clone()) {
            return Ok(usage(format!(
                "{} and {other} would both be decrypted to {plaintext:?} (names are compared \
                 without regard to case). Nothing was decrypted",
                content.relative
            )));
        }

        planned.push((
            Entry {
                plaintext,
                payload: content.relative.clone(),
                plaintext_hash: hex(&loaded.plaintext),
                payload_hash: hex(&stored),
            },
            loaded.plaintext,
        ));
    }

    // §6.6 (4): recorded before the first plaintext byte exists.
    let record = Record {
        version: RECORD_VERSION,
        vault: vault.directory.clone(),
        tool: concat!("fjord ", env!("CARGO_PKG_VERSION")).to_string(),
        created_at: scalar::now_rfc3339_utc(),
        complete: false,
        entries: planned.iter().map(|(entry, _)| entry.clone()).collect(),
    };
    write_record(root, &record)?;

    let mut written: Vec<PathBuf> = Vec::new();
    for (entry, plaintext) in &planned {
        let path = on_disk(vault, &entry.plaintext);
        if let Err(err) = write_new(&path, plaintext) {
            // Put things back as they were: the checkout never began.
            for path in &written {
                shred(path);
            }
            remove_record(root, &vault.directory);
            return Err(anyhow::Error::new(err)
                .context(format!(
                    "could not write {}/{}",
                    vault.directory, entry.plaintext
                ))
                .context("the checkout was undone and nothing was left behind"));
        }
        written.push(path);
    }

    // Every file exists: from here a missing one really is a deletion.
    let record = Record {
        complete: true,
        ..record
    };
    write_record(root, &record)?;

    if global.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "vault": vault.directory,
                "files": record.entries.iter().map(|e| e.plaintext.clone()).collect::<Vec<_>>(),
            }))
            .unwrap_or_else(|_| "{}".to_string())
        );
        return Ok(ExitCode::Ok);
    }

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {} in {}",
            style.good("decrypted"),
            plural(planned.len(), "document", "documents"),
            vault.directory
        );
        println!();
        println!("  Edit them where they are. They sit beside their .age files, and git");
        println!("  ignores them. Then check the vault back in:");
        println!();
        println!("      fjord encrypt {}", vault.directory);
        println!();
        println!(
            "  {}",
            style.warning("Until you do, `fjord sync`, `rekey` and `vault add --commit` refuse.")
        );
        println!(
            "  {}",
            style.dim("Anything with access to this directory can read the contents meanwhile.")
        );
    }
    Ok(ExitCode::Ok)
}

/// Why a decrypted name cannot be used, if it cannot.
fn unusable_name(plaintext: &str, suffix: &str, machinery: &[String]) -> Option<String> {
    if let Some(code) = rules::check_manifest_path(plaintext) {
        return Some(format!("is not a safe path ({})", code.as_str()));
    }
    if plaintext.ends_with(suffix) {
        return Some(format!(
            "would end in {suffix} and be mistaken for an encrypted payload"
        ));
    }
    if machinery.iter().any(|name| name == plaintext) {
        return Some("is the name of a file the vault keeps for itself".to_string());
    }
    if is_noise(plaintext) {
        return Some(
            "looks like an operating-system or editor file, which check-in removes".to_string(),
        );
    }
    None
}

/// Create `path` and write `bytes`, refusing to replace anything. Owner-only
/// where the platform has such a thing.
fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn recipients_of(vault: &Vault) -> Result<Recipients> {
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
        anyhow::bail!(
            "the {} vault has no recipients, so nothing could be written back to it. \
             Add one with `fjord key add`",
            vault.directory
        );
    }
    Ok(recipients)
}

// --- encrypt <vault> ---------------------------------------------------------

/// What check-in will do with one file.
#[derive(Debug)]
struct Put {
    plaintext: String,
    payload: String,
    stored: Vec<u8>,
    plaintext_hash: String,
    kind: Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Changed,
    Added,
}

/// Check a vault back in: re-encrypt what changed, add what is new, remove
/// what was deleted (after asking), and end the checkout.
pub fn encrypt(
    root: &Path,
    vault: &Vault,
    args: &EncryptArgs,
    global: &GlobalArgs,
) -> Result<ExitCode> {
    if let Some(code) = ensure_writable(root)? {
        return Ok(code);
    }
    if args.keep {
        return Ok(usage(
            "--keep applies to a single file. A vault is checked in whole",
        ));
    }
    if !vault.is_encrypted() {
        return Ok(usage(format!(
            "the {} vault is not encrypted, so there is nothing to check in",
            vault.directory
        )));
    }

    let record = match find(root, &vault.directory)? {
        Some(record) => record,
        None => {
            return Ok(usage(format!(
                "the {0} vault is not checked out. `fjord decrypt {0}` starts a checkout; a \
                 single stray file is encrypted with `fjord encrypt <path>`",
                vault.directory
            )))
        }
    };

    let suffix = vault.suffix();
    let contents = vault
        .contents()
        .with_context(|| format!("could not read the {} vault", vault.directory))?;
    let in_the_clear: BTreeSet<String> = contents
        .iter()
        .filter(|content| !content.is_payload)
        .map(|content| content.relative.clone())
        .collect();
    let payloads_now: BTreeSet<String> = contents
        .iter()
        .filter(|content| content.is_payload)
        .map(|content| content.relative.clone())
        .collect();

    if args.discard {
        return discard(root, vault, &in_the_clear, args, global);
    }

    if !record.complete {
        return Ok(usage(format!(
            "decrypting the {0} vault was interrupted, so some documents were never written \
             and checking in could mistake them for deletions. Nothing was changed. Run \
             `fjord encrypt {0} --discard` to clear what was written, then `fjord decrypt {0}` \
             again. Your payloads were not touched",
            vault.directory
        )));
    }

    let recipients = recipients_of(vault)?;
    let identities = load_identities(global)?;

    // §6.6 (7): a payload that changed while the vault was out is somebody
    // else's work. Refuse, and touch nothing.
    let mut conflicts = Vec::new();
    for entry in &record.entries {
        let path = on_disk(vault, &entry.payload);
        match std::fs::read(&path) {
            Ok(bytes) if hex(&bytes) == entry.payload_hash => {}
            Ok(_) => conflicts.push(format!("{} changed", entry.payload)),
            Err(_) => conflicts.push(format!("{} is gone", entry.payload)),
        }
    }
    if !conflicts.is_empty() {
        return Ok(usage(format!(
            "{} changed on disk since the vault was decrypted ({}), so checking in would \
             overwrite someone's work. Nothing was changed. Copy your edits aside, \
             `fjord encrypt {} --discard`, and decrypt again",
            plural(conflicts.len(), "payload", "payloads"),
            conflicts.join("; "),
            vault.directory
        )));
    }

    let by_plaintext: BTreeMap<&str, &Entry> = record
        .entries
        .iter()
        .map(|entry| (entry.plaintext.as_str(), entry))
        .collect();
    let id_naming = store::names_by_id(vault);

    let mut writes: Vec<Put> = Vec::new();
    let mut deleted: Vec<&Entry> = Vec::new();
    let mut noise: Vec<String> = Vec::new();

    for entry in &record.entries {
        if !in_the_clear.contains(&entry.plaintext) {
            deleted.push(entry);
            continue;
        }
        let bytes = read_plaintext(vault, &entry.plaintext)?;
        if hex(&bytes) == entry.plaintext_hash {
            continue;
        }
        writes.push(Put {
            plaintext: entry.plaintext.clone(),
            payload: entry.payload.clone(),
            stored: store::store(vault, leaf(&entry.plaintext), &bytes, Some(&recipients))
                .with_context(|| format!("could not encrypt {}", entry.plaintext))?,
            plaintext_hash: hex(&bytes),
            kind: Kind::Changed,
        });
    }

    // Payload paths this run will claim, so two files cannot take one name.
    let mut claimed: BTreeSet<String> = payloads_now.clone();
    for entry in &deleted {
        claimed.remove(&entry.payload);
    }
    // In an `id` vault a document's payload is named after its id (§7.2), so
    // a document renamed in the editor is a modification in place.
    let stems: BTreeMap<String, &Entry> = record
        .entries
        .iter()
        .map(|entry| (stem(&entry.payload, &suffix), entry))
        .collect();
    let mut moved: BTreeSet<String> = BTreeSet::new();
    let mut retargeted: Vec<String> = Vec::new(); // payloads left behind by a move

    for path in &in_the_clear {
        if by_plaintext.contains_key(path.as_str()) {
            continue;
        }
        if is_noise(path) {
            noise.push(path.clone());
            continue;
        }
        let bytes = read_plaintext(vault, path)?;

        let payload = if id_naming {
            let id = document_id(path, &bytes);
            match id.as_deref().and_then(|id| stems.get(id)) {
                Some(entry) if !in_the_clear.contains(&entry.plaintext) => {
                    // The same document under another name or directory.
                    moved.insert(entry.payload.clone());
                    let payload = join(
                        parent(path),
                        &format!("{}{}", stem(&entry.payload, &suffix), suffix),
                    );
                    if payload != entry.payload {
                        retargeted.push(entry.payload.clone());
                    }
                    payload
                }
                Some(entry) => {
                    return Ok(usage(format!(
                        "{path} has the same id as {} (spec §8.3 makes ids unique). Nothing \
                         was changed. Give it a new id, or remove one of them",
                        entry.plaintext
                    )))
                }
                None => {
                    let name = id.unwrap_or_else(scalar::new_ulid);
                    join(parent(path), &format!("{name}{suffix}"))
                }
            }
        } else {
            format!("{path}{suffix}")
        };

        if claimed.contains(&payload) {
            return Ok(usage(format!(
                "{path} would be encrypted to {payload}, which already exists and is not \
                 part of this checkout. Nothing was changed. Rename {path}, or deal with \
                 {payload} first"
            )));
        }
        claimed.insert(payload.clone());

        writes.push(Put {
            plaintext: path.clone(),
            payload,
            stored: store::store(vault, leaf(path), &bytes, Some(&recipients))
                .with_context(|| format!("could not encrypt {path}"))?,
            plaintext_hash: hex(&bytes),
            kind: Kind::Added,
        });
    }

    // A deletion that a move accounts for is not a deletion.
    let deleted: Vec<&Entry> = deleted
        .into_iter()
        .filter(|entry| !moved.contains(&entry.payload))
        .collect();

    // Read every payload back before anything is written (§6.6 (8)). If
    // none of your identities is a recipient this fails here, and the
    // checkout is still intact.
    for write in &writes {
        let expected = read_plaintext(vault, &write.plaintext)?;
        let loaded = store::load(vault, &write.stored, Some(&identities));
        let ok = matches!(&loaded, Ok(loaded) if loaded.plaintext[..] == expected[..]);
        if !ok {
            return Ok(usage(format!(
                "{} could not be read back after encrypting it, so nothing was written. \
                 Check that one of your identities is in {}/recipients.txt",
                write.plaintext, vault.directory
            )));
        }
    }

    let changed = writes.iter().filter(|w| w.kind == Kind::Changed).count();
    let added = writes.iter().filter(|w| w.kind == Kind::Added).count();

    if !global.quiet && !global.json {
        report_plan(
            &Style::detect(),
            vault,
            changed,
            added,
            &deleted,
            &noise,
            &writes,
        );
    }

    if args.dry_run {
        if global.json {
            print_json(vault, &writes, &deleted, true);
        } else if !global.quiet {
            println!();
            println!("  {}", Style::detect().dim("dry run: nothing was changed"));
        }
        return Ok(ExitCode::Ok);
    }

    if !deleted.is_empty() {
        match confirm_deletions(&deleted, vault, args, global) {
            Confirmation::Yes => {}
            Confirmation::No => {
                if !global.quiet {
                    println!("  {}", Style::detect().dim("left alone: still checked out"));
                }
                return Ok(ExitCode::Ok);
            }
            Confirmation::Refused(message) => return Ok(usage(message)),
        }
    }

    // --- Apply. Payloads first, then the record, and only then the
    // plaintext: until the last step the checkout is intact.
    for write in &writes {
        let path = on_disk(vault, &write.payload);
        if let Some(directory) = path.parent() {
            std::fs::create_dir_all(directory)
                .with_context(|| format!("could not create {}", directory.display()))?;
        }
        write_atomically(&path, &write.stored)
            .with_context(|| format!("could not write {}/{}", vault.directory, write.payload))?;
    }
    for entry in &deleted {
        std::fs::remove_file(on_disk(vault, &entry.payload))
            .with_context(|| format!("could not remove {}/{}", vault.directory, entry.payload))?;
    }
    for payload in &retargeted {
        let _ = std::fs::remove_file(on_disk(vault, payload));
    }

    // Rewrite the record to match, so that a run interrupted from here on
    // can be repeated without mistaking its own work for someone else's.
    let mut next = record.clone();
    let replaced: BTreeSet<&str> = deleted
        .iter()
        .map(|entry| entry.payload.as_str())
        .chain(moved.iter().map(String::as_str))
        .chain(writes.iter().map(|put| put.payload.as_str()))
        .collect();
    next.entries
        .retain(|entry| !replaced.contains(entry.payload.as_str()));
    for write in &writes {
        next.entries.push(Entry {
            plaintext: write.plaintext.clone(),
            payload: write.payload.clone(),
            plaintext_hash: write.plaintext_hash.clone(),
            payload_hash: hex(&write.stored),
        });
    }
    write_record(root, &next)?;

    for path in &in_the_clear {
        shred(&on_disk(vault, path));
    }
    // Directories that held only what this check-in removed: the plaintext
    // it shredded, and the payloads of deleted or moved documents.
    let removed: BTreeSet<String> = in_the_clear
        .iter()
        .cloned()
        .chain(deleted.iter().map(|entry| entry.payload.clone()))
        .chain(retargeted.iter().cloned())
        .collect();
    remove_emptied_directories(vault, &removed);
    remove_record(root, &vault.directory);

    if global.json {
        print_json(vault, &writes, &deleted, false);
        return Ok(ExitCode::Ok);
    }
    if !global.quiet {
        let style = Style::detect();
        println!();
        println!(
            "  {} {} is encrypted again. Nothing is in the clear.",
            style.good("checked in:"),
            vault.directory
        );
        println!(
            "  {}",
            style.dim("nothing was committed; `fjord sync` commits and pushes")
        );
    }
    Ok(ExitCode::Ok)
}

fn stem(payload: &str, suffix: &str) -> String {
    let name = leaf(payload);
    name.strip_suffix(suffix).unwrap_or(name).to_string()
}

/// The id a document declares, if it is Markdown with a valid one.
fn document_id(path: &str, bytes: &[u8]) -> Option<String> {
    if !path.ends_with(".md") {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    match doc::parse(text) {
        doc::Parse::Present { frontmatter, .. } => frontmatter.doc_id().map(String::from),
        _ => None,
    }
}

fn read_plaintext(vault: &Vault, relative: &str) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    std::fs::read(on_disk(vault, relative))
        .map(zeroize::Zeroizing::new)
        .with_context(|| format!("could not read {}/{relative}", vault.directory))
}

/// Remove directories that shredding `files` left empty, walking up towards
/// the vault root and stopping at anything that is not empty. A directory
/// that was already empty before the checkout is none of our business.
fn remove_emptied_directories(vault: &Vault, files: &BTreeSet<String>) {
    for file in files {
        let mut directory = parent(file);
        while let Some(current) = directory {
            // Fails, harmlessly, unless the directory is empty.
            if std::fs::remove_dir(on_disk(vault, current)).is_err() {
                break;
            }
            directory = parent(current);
        }
    }
}

fn discard(
    root: &Path,
    vault: &Vault,
    in_the_clear: &BTreeSet<String>,
    args: &EncryptArgs,
    global: &GlobalArgs,
) -> Result<ExitCode> {
    if args.dry_run {
        if !global.quiet {
            println!(
                "  would discard {} in {}",
                plural(in_the_clear.len(), "decrypted file", "decrypted files"),
                vault.directory
            );
        }
        return Ok(ExitCode::Ok);
    }
    if !args.yes {
        if global.no_input || !std::io::stdin().is_terminal() {
            return Ok(usage(
                "discarding the decrypted copies needs confirmation. Pass --yes to say so \
                 without being asked",
            ));
        }
        eprintln!(
            "Discard {} in {} without saving? Edits made since `fjord decrypt` are lost.",
            plural(in_the_clear.len(), "decrypted file", "decrypted files"),
            vault.directory
        );
        eprint!("Continue? [y/N]: ");
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        let read = std::io::stdin().read_line(&mut line)?;
        if read == 0 || !matches!(line.trim().to_lowercase().as_str(), "y" | "yes") {
            if !global.quiet {
                println!("  left alone");
            }
            return Ok(ExitCode::Ok);
        }
    }
    for path in in_the_clear {
        shred(&on_disk(vault, path));
    }
    remove_emptied_directories(vault, in_the_clear);
    remove_record(root, &vault.directory);
    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {} in {}",
            style.good("discarded"),
            plural(in_the_clear.len(), "decrypted file", "decrypted files"),
            vault.directory
        );
    }
    Ok(ExitCode::Ok)
}

enum Confirmation {
    Yes,
    No,
    Refused(String),
}

fn confirm_deletions(
    deleted: &[&Entry],
    vault: &Vault,
    args: &EncryptArgs,
    global: &GlobalArgs,
) -> Confirmation {
    if args.yes {
        return Confirmation::Yes;
    }
    if global.no_input {
        // CLAUDE.md: with `--no-input` a required prompt is a usage error,
        // never a hang.
        return Confirmation::Refused(
            "documents were deleted while the vault was decrypted, and removing their \
             payloads needs confirmation. Pass --yes to say so without being asked"
                .to_string(),
        );
    }
    if !std::io::stdin().is_terminal() {
        return Confirmation::Refused(
            "documents were deleted while the vault was decrypted, and removing their \
             payloads needs confirmation, and there is no terminal to ask on. Pass --yes"
                .to_string(),
        );
    }
    eprintln!(
        "Remove the encrypted copies of {} deleted from {}? Git history still holds them.",
        plural(deleted.len(), "document", "documents"),
        vault.directory
    );
    eprint!("Continue? [y/N]: ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(read) if read > 0 && matches!(line.trim().to_lowercase().as_str(), "y" | "yes") => {
            Confirmation::Yes
        }
        _ => Confirmation::No,
    }
}

fn report_plan(
    style: &Style,
    vault: &Vault,
    changed: usize,
    added: usize,
    deleted: &[&Entry],
    noise: &[String],
    writes: &[Put],
) {
    let unchanged_note = changed + added + deleted.len() == 0;
    if unchanged_note {
        println!(
            "  {}",
            style.dim(&format!("{}: nothing changed", vault.directory))
        );
    }
    let list = |label: &str, names: Vec<&str>| {
        if names.is_empty() {
            return;
        }
        println!("  {label} ({}):", names.len());
        for name in names.iter().take(NAMED) {
            println!("    {name}");
        }
        if names.len() > NAMED {
            println!("    … and {} more", names.len() - NAMED);
        }
    };
    list(
        "re-encrypted",
        writes
            .iter()
            .filter(|w| w.kind == Kind::Changed)
            .map(|w| w.plaintext.as_str())
            .collect(),
    );
    list(
        "new",
        writes
            .iter()
            .filter(|w| w.kind == Kind::Added)
            .map(|w| w.plaintext.as_str())
            .collect(),
    );
    list(
        "deleted, so their encrypted copies will be removed",
        deleted.iter().map(|e| e.plaintext.as_str()).collect(),
    );
    list(
        "editor and system files, removed",
        noise.iter().map(String::as_str).collect(),
    );
}

fn print_json(vault: &Vault, writes: &[Put], deleted: &[&Entry], dry_run: bool) {
    let names = |kind: Kind| -> Vec<String> {
        writes
            .iter()
            .filter(|w| w.kind == kind)
            .map(|w| w.plaintext.clone())
            .collect()
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "vault": vault.directory,
            "dryRun": dry_run,
            "changed": names(Kind::Changed),
            "added": names(Kind::Added),
            "removed": deleted.iter().map(|e| e.plaintext.clone()).collect::<Vec<_>>(),
        }))
        .unwrap_or_else(|_| "{}".to_string())
    );
}

/// Used by the dispatcher in `crypt`: the vault a path names, if the path is
/// a vault's own directory rather than something inside it.
pub fn vault_named(root: &Path, relative: &str) -> Result<Option<Vault>> {
    let relative = relative.trim_end_matches('/');
    Ok(vault::discover(root)
        .context("could not read the repository's vaults")?
        .into_iter()
        .find(|vault| vault.directory == relative))
}

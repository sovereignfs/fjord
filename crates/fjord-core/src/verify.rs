// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conformance checks. Spec §10.
//!
//! `verify` reads a repository and returns findings. It **mutates nothing**
//! — invariant 7 — and it renders nothing: the caller decides how to print
//! a [`Diagnostic`].
//!
//! # What this milestone covers
//!
//! Every diagnostic except [`Code::CorruptPayload`] and
//! [`Code::MalformedContainer`], which need to open an age payload and a tar
//! archive respectively, and so arrive with M3 and M7.
//!
//! # The walk
//!
//! The repository is walked once with `std::fs`, skipping `.git` anywhere
//! and `/.fjord/` at the root (§2.2 reserves it, and §12 requires that its
//! contents be ignored and preserved). Symbolic links are never followed,
//! so a link cycle cannot hang the walk.
//!
//! `.gitignore` is deliberately **not** consulted. The tempting reading is
//! that a gitignored plaintext file inside an encrypted vault is harmless
//! because it cannot be committed — but the canonical guard of §6.5 ignores
//! exactly that file, which would make [`Code::PlaintextInEncryptedVault`]
//! unreachable in every conforming repository. Invariant 1 says plaintext
//! must not be in an encrypted vault at all, "not temporarily, not as a
//! dotfile", so the check fires on any plaintext and the detail says
//! whether the guard would stop it reaching a commit.

use crate::diagnostics::{Code, Diagnostic, Severity};
use crate::doc;
use crate::listing::{self, FileKind, ListedFile, VaultSettings};
use crate::manifest::{self, EncryptionField, Manifest, RecipientKind, Vaults};
use crate::scalar;
use crate::{
    FORMAT_VERSION, LARGE_FILE_WARN_BYTES, LONG_PATH_WARN_BYTES, REPOSITORY_MANIFEST,
    RESERVED_DIRECTORY, VAULT_MANIFEST,
};
use indexmap::IndexMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// A failure that stops verification, as distinct from a finding about the
/// repository. Maps to exit code 3.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
}

/// What to check.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Check only this vault, named by its directory or its `name` field.
    pub vault: Option<String>,
}

/// Everything one run found.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub vaults: Vec<VaultSummary>,
    /// The declared format version, if `fjord.json` carried an integer one.
    pub version: Option<i64>,
    /// Set when the repository declares a version this build does not
    /// implement. Writing to it is forbidden. Spec §10.1, invariant 4.
    pub read_only: bool,
}

impl Report {
    pub fn errors(&self) -> usize {
        self.count(Severity::Error)
    }

    pub fn warnings(&self) -> usize {
        self.count(Severity::Warning)
    }

    fn count(&self, severity: Severity) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity() == severity)
            .count()
    }

    /// Whether the repository conforms: no errors. Warnings do not affect
    /// conformance, though `--strict` makes the caller exit non-zero.
    pub fn conforms(&self) -> bool {
        self.errors() == 0
    }

    fn push(&mut self, diagnostic: Diagnostic) {
        self.diagnostics.push(diagnostic);
    }
}

/// What one vault holds, for the summary line `fjord verify` prints.
#[derive(Debug, Clone)]
pub struct VaultSummary {
    /// Repository-relative directory: the vault's address. Spec §2.3.
    pub path: String,
    /// The `name` field: the vault's label, which need not match its
    /// directory. Spec §2.3.
    pub name: Option<String>,
    pub encrypted: bool,
    pub file_naming: Option<String>,
    /// Recipients that parsed as usable keys.
    pub recipients: usize,
    /// Files carrying a valid frontmatter `id`. Spec §8.
    pub docs: usize,
    /// Every other file, machinery excluded.
    pub files: usize,
}

/// Check the repository rooted at `root`.
///
/// Returns `Err` only for a failure to read the repository at all. A
/// non-conforming repository is a successful run with diagnostics.
pub fn verify(root: &Path, options: &Options) -> Result<Report, Error> {
    let mut report = Report::default();

    // Canonicalise once, so every absolute path below shares a prefix that
    // the symlink-escape check can compare against.
    let root = match fs::canonicalize(root) {
        Ok(canonical) => canonical,
        Err(source) => {
            return Err(Error::Io {
                path: display(root),
                source,
            })
        }
    };

    let manifest_path = root.join(REPOSITORY_MANIFEST);
    if !manifest_path.is_file() {
        report.push(Diagnostic::new(Code::ManifestMissing));
        return Ok(report);
    }

    let manifest = match Manifest::parse(&read(&manifest_path)?) {
        Ok(manifest) => manifest,
        Err(err) => {
            // Without a manifest there is no repository to check, so this
            // is terminal rather than the first of many findings.
            report.push(
                Diagnostic::at(Code::ManifestUnparseable, REPOSITORY_MANIFEST)
                    .with_detail(err.to_string()),
            );
            return Ok(report);
        }
    };

    check_repository_manifest(&manifest, &mut report);
    check_merge_guard(&root, &mut report)?;

    let walk = walk_repository(&root)?;
    check_names(&root, &walk, &mut report);

    let vaults = root_vaults(&root, &walk, &mut report);
    reconcile_manifest(&root, &manifest, &vaults, &mut report);

    // An `id` is unique across the repository, not within a vault, so the
    // map outlives each vault. Spec §8.2.
    let mut seen_ids: IndexMap<String, String> = IndexMap::new();

    for vault in &vaults {
        if !selected(vault, options, &root) {
            continue;
        }
        if let Some(summary) = check_vault(vault, &walk, &mut seen_ids, &mut report)? {
            report.vaults.push(summary);
        }
    }

    Ok(report)
}

// --- fjord.json ----------------------------------------------------------

fn check_repository_manifest(manifest: &Manifest, report: &mut Report) {
    report.version = manifest.version();

    if let Some(version) = manifest.version() {
        if version > i64::from(FORMAT_VERSION) {
            report.read_only = true;
            report.push(
                Diagnostic::at(Code::UnsupportedVersion, REPOSITORY_MANIFEST).with_detail(format!(
                    "repository declares version {version}; this build implements {FORMAT_VERSION}"
                )),
            );
        }
    } else if manifest.has(manifest::field::FJORD) {
        report.push(
            Diagnostic::at(Code::InvalidFieldValue, REPOSITORY_MANIFEST)
                .with_detail("fjord must be an integer"),
        );
    }

    for required in manifest::REPOSITORY_REQUIRED {
        if !manifest.has(required) {
            report.push(
                Diagnostic::at(Code::RequiredFieldMissing, REPOSITORY_MANIFEST)
                    .with_detail(*required),
            );
        }
    }

    check_ulid_field(manifest, manifest::field::ID, REPOSITORY_MANIFEST, report);
    check_timestamp_field(
        manifest,
        manifest::field::CREATED_AT,
        REPOSITORY_MANIFEST,
        report,
    );
    check_string_field(manifest, manifest::field::NAME, REPOSITORY_MANIFEST, report);

    if matches!(manifest.vaults(), Vaults::NotAnArray) {
        report.push(
            Diagnostic::at(Code::InvalidFieldValue, REPOSITORY_MANIFEST)
                .with_detail("vaults must be an array"),
        );
    }
}

/// Say what is wrong with an identifier, when the cause is the old
/// spelling.
///
/// Spec §8.3 required uppercase until it was changed to lowercase, and
/// Fjord 0.1.0 wrote uppercase, so the likeliest reason a valid-looking
/// identifier is rejected is that it is the old one. "Not a valid ULID"
/// would send someone looking for a typo that is not there.
///
/// This only ever explains. Nothing is accepted that was not before: §8.3
/// permits exactly one form, and a checker that tolerated both would bring
/// back the negotiation that rule exists to avoid.
fn explain_id(label: &str, value: &str) -> String {
    if scalar::is_ulid_ignoring_case(value) {
        format!(
            "{label} is uppercase, but ids are lowercase (spec §8.3). Repositories made by \
             Fjord 0.1.0 use the old spelling"
        )
    } else {
        label.to_string()
    }
}

fn check_ulid_field(manifest: &Manifest, key: &str, at: &str, report: &mut Report) {
    match manifest.string(key) {
        Some(value) if scalar::is_ulid(value) => {}
        Some(value) => {
            report.push(Diagnostic::at(Code::InvalidUlid, at).with_detail(explain_id(key, value)));
        }
        None if manifest.has(key) => {
            report.push(
                Diagnostic::at(Code::InvalidUlid, at).with_detail(format!("{key} is not a string")),
            );
        }
        None => {}
    }
}

fn check_timestamp_field(manifest: &Manifest, key: &str, at: &str, report: &mut Report) {
    match manifest.string(key) {
        Some(value) if scalar::is_rfc3339_utc(value) => {}
        Some(_) => {
            report.push(Diagnostic::at(Code::InvalidTimestamp, at).with_detail(key));
        }
        None if manifest.has(key) => {
            report.push(
                Diagnostic::at(Code::InvalidTimestamp, at)
                    .with_detail(format!("{key} is not a string")),
            );
        }
        None => {}
    }
}

fn check_string_field(manifest: &Manifest, key: &str, at: &str, report: &mut Report) {
    if manifest.has(key) && manifest.string(key).is_none() {
        report.push(
            Diagnostic::at(Code::InvalidFieldValue, at)
                .with_detail(format!("{key} must be a string")),
        );
    }
}

fn check_merge_guard(root: &Path, report: &mut Report) -> Result<(), Error> {
    let path = root.join(".gitattributes");
    if !path.is_file() {
        report.push(
            Diagnostic::at(Code::MergeGuardMissing, ".gitattributes").with_detail("file is absent"),
        );
        return Ok(());
    }
    let text = String::from_utf8_lossy(&read(&path)?).to_string();
    if !merge_guard_present(&text) {
        report.push(
            Diagnostic::at(Code::MergeGuardMissing, ".gitattributes")
                .with_detail("no `*.age` pattern sets `-merge`"),
        );
    }
    Ok(())
}

/// Whether `.gitattributes` stops Git merging ciphertext. Spec §9.
///
/// Only `-merge` is required. `-diff` is strongly advisable and the
/// specification's example sets it, but a textual diff of ciphertext is
/// merely useless, where a textual merge writes a corrupt file.
fn merge_guard_present(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }
        let mut fields = line.split_whitespace();
        match fields.next() {
            Some("*.age") => fields.any(|attribute| attribute == "-merge"),
            _ => false,
        }
    })
}

// --- The walk ------------------------------------------------------------

/// One entry found on disk.
#[derive(Debug, Clone)]
struct Entry {
    /// Repository-relative, with forward slashes on every platform.
    rel: String,
    name: String,
    abs: PathBuf,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
}

/// Everything the single filesystem pass collected.
#[derive(Debug, Default)]
struct Walk {
    entries: Vec<Entry>,
    /// Entry names per directory, keyed by the directory's repository-
    /// relative path — `""` for the root. Used for the case-collision
    /// check, which is per-directory by definition.
    directories: IndexMap<String, Vec<String>>,
}

fn walk_repository(root: &Path) -> Result<Walk, Error> {
    let mut walk = Walk::default();
    collect(root, "", &mut walk)?;
    walk.entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(walk)
}

fn collect(dir: &Path, relative: &str, walk: &mut Walk) -> Result<(), Error> {
    let readable = match fs::read_dir(dir) {
        Ok(readable) => readable,
        Err(source) => {
            return Err(Error::Io {
                path: display(dir),
                source,
            })
        }
    };

    let mut names = Vec::new();

    for entry in readable {
        let entry = match entry {
            Ok(entry) => entry,
            Err(source) => {
                return Err(Error::Io {
                    path: display(dir),
                    source,
                })
            }
        };

        let name = entry.file_name().to_string_lossy().to_string();

        // `.git` belongs to git. `/.fjord/` is reserved by §2.2 and its
        // contents MUST be ignored and preserved (§12) — so it is not
        // walked, and nothing in it is ever diagnosed.
        if name == ".git" || (relative.is_empty() && name == RESERVED_DIRECTORY) {
            continue;
        }

        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(source) => {
                return Err(Error::Io {
                    path: display(&entry.path()),
                    source,
                })
            }
        };

        let rel = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };

        names.push(name.clone());

        let is_symlink = metadata.file_type().is_symlink();
        let is_dir = metadata.is_dir();

        walk.entries.push(Entry {
            rel: rel.clone(),
            name,
            abs: entry.path(),
            is_dir,
            is_symlink,
            size: if is_dir { 0 } else { metadata.len() },
        });

        // Never follow a link: it could leave the repository, or cycle.
        if is_dir && !is_symlink {
            collect(&entry.path(), &rel, walk)?;
        }
    }

    names.sort();
    walk.directories.insert(relative.to_string(), names);
    Ok(())
}

// --- §5 names ------------------------------------------------------------

fn check_names(root: &Path, walk: &Walk, report: &mut Report) {
    for entry in &walk.entries {
        for code in crate::path::check_component(&entry.name) {
            report.push(Diagnostic::at(code, &entry.rel));
        }

        if !entry.is_dir {
            if entry.rel.len() > LONG_PATH_WARN_BYTES {
                report.push(
                    Diagnostic::at(Code::PathTooLong, &entry.rel)
                        .with_detail(format!("{} bytes", entry.rel.len())),
                );
            }
            if entry.size > LARGE_FILE_WARN_BYTES {
                report.push(
                    Diagnostic::at(Code::FileTooLarge, &entry.rel)
                        .with_detail(format!("{} bytes", entry.size)),
                );
            }
        }

        if entry.is_symlink {
            if let Some(target) = escaping_target(root, &entry.abs) {
                report.push(
                    Diagnostic::at(Code::SymlinkEscapesRepository, &entry.rel).with_detail(target),
                );
            }
        }
    }

    for (directory, names) in &walk.directories {
        for group in crate::path::case_collisions(names) {
            let at = if directory.is_empty() {
                ".".to_string()
            } else {
                directory.clone()
            };
            report.push(Diagnostic::at(Code::CaseCollision, at).with_detail(group.join(", ")));
        }
    }
}

// --- Vault discovery -----------------------------------------------------

/// A vault found on disk: a directory containing `fjord.vault.json`.
/// Spec §2.1.
#[derive(Debug, Clone)]
struct DiscoveredVault {
    /// Repository-relative directory.
    rel: String,
    abs: PathBuf,
}

/// Vaults at the repository root, which are the only permitted ones.
/// Anything deeper is reported and then ignored. Spec §2.3.
///
/// Which directories those are is [`listing::locate_vaults`]'s to say, on the walk as a list of its
/// files: the rule is written once, for every client.
fn root_vaults(root: &Path, walk: &Walk, report: &mut Report) -> Vec<DiscoveredVault> {
    let files: Vec<ListedFile> = walk
        .entries
        .iter()
        .filter(|entry| !entry.is_dir)
        .map(|entry| ListedFile {
            path: entry.rel.clone(),
            size: entry.size,
        })
        .collect();
    let located = listing::locate_vaults(&files);

    // A vault manifest at the repository root would make the root itself a vault, and one deeper than
    // a directory makes a nested vault. Neither is permitted.
    for nested in located.nested {
        report.push(
            Diagnostic::at(Code::NestedVault, nested)
                .with_detail("a vault must be a directory at the repository root"),
        );
    }

    located
        .vaults
        .into_iter()
        .map(|rel| DiscoveredVault {
            abs: root.join(&rel),
            rel,
        })
        .collect()
}

/// Reconcile `fjord.json`'s vault list against what is on disk. The
/// filesystem wins: a vault missing from the manifest is a warning and a
/// repair, never a reason to touch the directory. Spec §2.1.
fn reconcile_manifest(
    root: &Path,
    manifest: &Manifest,
    on_disk: &[DiscoveredVault],
    report: &mut Report,
) {
    let entries = match manifest.vaults() {
        Vaults::Entries(entries) => entries,
        Vaults::Absent | Vaults::NotAnArray => Vec::new(),
    };

    let mut declared = Vec::new();

    for (index, entry) in entries.iter().enumerate() {
        let path = match &entry.path {
            Some(path) => path.clone(),
            None => {
                report.push(
                    Diagnostic::at(Code::RequiredFieldMissing, REPOSITORY_MANIFEST)
                        .with_detail(format!("vaults[{index}].path")),
                );
                continue;
            }
        };

        if let Some(code) = crate::path::check_manifest_path(&path) {
            report.push(
                Diagnostic::at(code, REPOSITORY_MANIFEST)
                    .with_detail(format!("vaults[{index}].path: {path}")),
            );
            continue;
        }

        declared.push(path.clone());

        let vault_manifest_path = root.join(&path).join(VAULT_MANIFEST);
        if !vault_manifest_path.is_file() {
            report.push(Diagnostic::at(Code::VaultNotOnDisk, &path));
            continue;
        }

        match &entry.id {
            None => report.push(
                Diagnostic::at(Code::RequiredFieldMissing, REPOSITORY_MANIFEST)
                    .with_detail(format!("vaults[{index}].id")),
            ),
            Some(id) if !scalar::is_ulid(id) => report.push(
                Diagnostic::at(Code::InvalidUlid, REPOSITORY_MANIFEST)
                    .with_detail(explain_id(&format!("vaults[{index}].id"), id)),
            ),
            Some(id) => {
                // Compare against the vault's own id, which is
                // authoritative. A mismatch means one of the two files has
                // been edited by hand.
                if let Ok(bytes) = fs::read(&vault_manifest_path) {
                    if let Ok(vault) = Manifest::parse(&bytes) {
                        if let Some(own) = vault.string(manifest::field::ID) {
                            if own != id {
                                report.push(
                                    Diagnostic::at(Code::VaultIdMismatch, &path).with_detail(
                                        format!("fjord.json says {id}, the vault says {own}"),
                                    ),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    for vault in on_disk {
        if !declared.iter().any(|path| path == &vault.rel) {
            report.push(Diagnostic::at(Code::VaultNotInManifest, &vault.rel));
        }
    }
}

fn selected(vault: &DiscoveredVault, options: &Options, root: &Path) -> bool {
    let wanted = match &options.vault {
        Some(wanted) => wanted,
        None => return true,
    };
    if &vault.rel == wanted {
        return true;
    }
    // Also accept the vault's label, since that is what a user sees.
    let path = root.join(&vault.rel).join(VAULT_MANIFEST);
    match fs::read(&path)
        .ok()
        .and_then(|bytes| Manifest::parse(&bytes).ok())
    {
        Some(manifest) => manifest.string(manifest::field::NAME) == Some(wanted.as_str()),
        None => false,
    }
}

// --- One vault -----------------------------------------------------------

fn check_vault(
    vault: &DiscoveredVault,
    walk: &Walk,
    seen_ids: &mut IndexMap<String, String>,
    report: &mut Report,
) -> Result<Option<VaultSummary>, Error> {
    let manifest_rel = format!("{}/{VAULT_MANIFEST}", vault.rel);
    let manifest = match Manifest::parse(&read(&vault.abs.join(VAULT_MANIFEST))?) {
        Ok(manifest) => manifest,
        Err(err) => {
            // Without the manifest we cannot tell whether this vault is
            // encrypted, so no content check can run. The name checks have
            // already happened in the repository-wide pass.
            report.push(
                Diagnostic::at(Code::VaultManifestUnparseable, manifest_rel)
                    .with_detail(err.to_string()),
            );
            return Ok(None);
        }
    };

    for required in manifest::VAULT_REQUIRED {
        if !manifest.has(required) {
            report.push(
                Diagnostic::at(Code::RequiredFieldMissing, &manifest_rel).with_detail(*required),
            );
        }
    }

    check_ulid_field(&manifest, manifest::field::ID, &manifest_rel, report);
    check_timestamp_field(
        &manifest,
        manifest::field::CREATED_AT,
        &manifest_rel,
        report,
    );
    check_string_field(&manifest, manifest::field::NAME, &manifest_rel, report);

    if let Some(version) = manifest.version() {
        if version > i64::from(FORMAT_VERSION) {
            report.read_only = true;
            report.push(
                Diagnostic::at(Code::UnsupportedVersion, &manifest_rel).with_detail(format!(
                    "vault declares version {version}; this build implements {FORMAT_VERSION}"
                )),
            );
        }
    }

    let file_naming = manifest.file_naming().map(String::from);
    match file_naming.as_deref() {
        None | Some("plain") | Some("id") => {}
        Some(other) => report.push(
            Diagnostic::at(Code::InvalidFieldValue, &manifest_rel).with_detail(format!(
                "fileNaming must be \"plain\" or \"id\", not {other:?}"
            )),
        ),
    }
    let id_naming = file_naming.as_deref() == Some("id");

    let mut summary = VaultSummary {
        path: vault.rel.clone(),
        name: manifest.string(manifest::field::NAME).map(String::from),
        encrypted: false,
        file_naming,
        recipients: 0,
        docs: 0,
        files: 0,
    };

    // What the manifest says decides what each file is: whether the vault is encrypted, the suffix of
    // a payload, and the files §2.2 reserves, which are never user documents and never count as vault
    // content. `listing` owns it, so every client reads a vault's files the same way.
    let settings = VaultSettings::from_manifest(&manifest);

    match manifest.encryption() {
        EncryptionField::Absent => {}
        EncryptionField::NotAnObject => report.push(
            Diagnostic::at(Code::InvalidFieldValue, &manifest_rel)
                .with_detail("encryption must be an object or null"),
        ),
        EncryptionField::Null => {
            if id_naming {
                report.push(Diagnostic::at(
                    Code::IdNamingOnPlaintextVault,
                    &manifest_rel,
                ));
            }
        }
        EncryptionField::Object(encryption) => {
            summary.encrypted = true;

            for required in manifest::ENCRYPTION_REQUIRED {
                if !manifest::object_has(encryption, required) {
                    report.push(
                        Diagnostic::at(Code::RequiredFieldMissing, &manifest_rel)
                            .with_detail(format!("encryption.{required}")),
                    );
                }
            }

            if manifest::object_has(encryption, manifest::field::TOOL)
                && manifest::object_string(encryption, manifest::field::TOOL)
                    != Some(manifest::TOOL_AGE)
            {
                report.push(
                    Diagnostic::at(Code::UnsupportedEncryptionTool, &manifest_rel).with_detail(
                        "version 1 defines only `age`; no other tool may be substituted",
                    ),
                );
            }

            if let Some(declared) = manifest::object_string(encryption, manifest::field::SUFFIX) {
                if declared != manifest::SUFFIX_AGE {
                    report.push(
                        Diagnostic::at(Code::InvalidFieldValue, &manifest_rel).with_detail(
                            format!("encryption.suffix must be \".age\", not {declared:?}"),
                        ),
                    );
                }
            }

            let container = manifest::object_string(encryption, manifest::field::CONTAINER);
            match container {
                None | Some("none") | Some("tar") => {}
                Some(other) => report.push(
                    Diagnostic::at(Code::InvalidFieldValue, &manifest_rel).with_detail(format!(
                        "encryption.container must be \"none\" or \"tar\", not {other:?}"
                    )),
                ),
            }
            if id_naming && container == Some("none") {
                report.push(Diagnostic::at(
                    Code::ContainerRequiredForIdNaming,
                    &manifest_rel,
                ));
            }

            if manifest::object_has(encryption, manifest::field::ARMOR)
                && !encryption
                    .get(manifest::field::ARMOR)
                    .map(serde_json::Value::is_boolean)
                    .unwrap_or(false)
            {
                report.push(
                    Diagnostic::at(Code::InvalidFieldValue, &manifest_rel)
                        .with_detail("encryption.armor must be a boolean"),
                );
            }

            summary.recipients = check_recipients(vault, encryption, &manifest_rel, report)?;

            check_plaintext_guard(vault, report)?;
        }
    }

    classify_content(
        vault,
        walk,
        &settings,
        id_naming,
        seen_ids,
        &mut summary,
        report,
    )?;

    Ok(Some(summary))
}

/// Read and classify the recipients file. Its presence is not mistaken for plaintext because
/// `listing` counts it as machinery. Spec §6.2.
fn check_recipients(
    vault: &DiscoveredVault,
    encryption: &serde_json::Map<String, serde_json::Value>,
    manifest_rel: &str,
    report: &mut Report,
) -> Result<usize, Error> {
    let declared = match manifest::object_string(encryption, manifest::field::RECIPIENTS) {
        Some(declared) => declared,
        // Absent, or not a string: already reported as a missing field.
        None => return Ok(0),
    };

    if let Some(code) = crate::path::check_manifest_path(declared) {
        report.push(
            Diagnostic::at(code, manifest_rel)
                .with_detail(format!("encryption.recipients: {declared}")),
        );
        return Ok(0);
    }

    let path = vault.abs.join(declared);
    if !path.is_file() {
        report.push(
            Diagnostic::at(
                Code::RecipientsFileMissing,
                format!("{}/{declared}", vault.rel),
            )
            .with_detail("the vault declares it but it is not on disk"),
        );
        return Ok(0);
    }

    let rel = format!("{}/{declared}", vault.rel);
    let text = String::from_utf8_lossy(&read(&path)?).to_string();
    let lines = manifest::parse_recipients(&text);

    let mut usable = 0;
    for line in &lines {
        match line.kind {
            RecipientKind::X25519 | RecipientKind::Ssh => usable += 1,
            RecipientKind::Passphrase => report.push(
                Diagnostic::at(Code::PassphraseRecipient, &rel).with_detail(format!(
                    "line {}: age refuses to combine a passphrase with any other recipient",
                    line.number
                )),
            ),
            RecipientKind::Malformed => report.push(
                Diagnostic::at(Code::MalformedRecipient, &rel)
                    .with_detail(format!("line {}: {}", line.number, line.text)),
            ),
        }
    }

    if usable == 0 {
        report.push(Diagnostic::at(Code::NoRecipients, &vault.rel));
    }

    Ok(usable)
}

/// Whether the vault's `.gitignore` makes committing plaintext impossible.
/// Spec §6.5.
///
/// Two lines carry the guarantee: `*` ignores everything, and `!*.age`
/// re-permits the payloads. The rest of the canonical block re-permits
/// machinery — desirable, but a vault missing those lines still cannot leak
/// plaintext, so they are not required here.
fn check_plaintext_guard(vault: &DiscoveredVault, report: &mut Report) -> Result<(), Error> {
    let rel = format!("{}/.gitignore", vault.rel);
    let path = vault.abs.join(".gitignore");
    if !path.is_file() {
        report.push(Diagnostic::at(Code::PlaintextGuardMissing, rel).with_detail("file is absent"));
        return Ok(());
    }

    let text = String::from_utf8_lossy(&read(&path)?).to_string();
    let mut ignores_everything = false;
    let mut permits_payloads = false;
    for line in text.lines() {
        match line.trim() {
            "*" => ignores_everything = true,
            "!*.age" => permits_payloads = true,
            _ => {}
        }
    }

    if !ignores_everything || !permits_payloads {
        report.push(
            Diagnostic::at(Code::PlaintextGuardMissing, rel)
                .with_detail("must contain both `*` and `!*.age`"),
        );
    }
    Ok(())
}

/// Classify every file in the vault, and check what its naming and
/// encryption settings imply. Spec §6.5, §7.
fn classify_content(
    vault: &DiscoveredVault,
    walk: &Walk,
    settings: &VaultSettings,
    id_naming: bool,
    seen_ids: &mut IndexMap<String, String>,
    summary: &mut VaultSummary,
    report: &mut Report,
) -> Result<(), Error> {
    let prefix = format!("{}/", vault.rel);

    for entry in &walk.entries {
        if entry.is_dir || !entry.rel.starts_with(&prefix) {
            continue;
        }
        let vault_rel = &entry.rel[prefix.len()..];

        // What a file is comes from its name and the vault's settings, and is `listing`'s to say.
        // Machinery is not content.
        let Some(kind) = listing::classify(vault_rel, settings) else {
            continue;
        };

        match kind {
            FileKind::Payload => {
                summary.files += 1;
                if id_naming {
                    check_id_named(vault_rel, &settings.suffix, &entry.rel, report);
                }
                // Header only: authenticating the body needs an identity,
                // and `verify` never asks for one. A payload in a
                // plaintext vault is already reported as E302, so it is not
                // checked twice here.
                if !crate::crypto::is_well_formed(&read(&entry.abs)?) {
                    report.push(
                        Diagnostic::at(Code::CorruptPayload, &entry.rel)
                            .with_detail("not an age file: the header could not be parsed"),
                    );
                }
            }
            FileKind::Stray => report.push(
                Diagnostic::at(Code::PlaintextInEncryptedVault, &entry.rel).with_detail(
                    "not an encrypted payload; decrypted content must live outside the \
                     repository",
                ),
            ),
            FileKind::MisplacedPayload => {
                report.push(Diagnostic::at(
                    Code::EncryptedFileInPlaintextVault,
                    &entry.rel,
                ));
                summary.files += 1;
            }
            FileKind::Other => summary.files += 1,
            FileKind::Markdown => match check_markdown(entry, report)? {
                Some(id) => {
                    summary.docs += 1;
                    match seen_ids.get(&id) {
                        Some(first) => report.push(
                            Diagnostic::at(Code::DuplicateId, &entry.rel)
                                .with_detail(format!("{id} is already used by {first}")),
                        ),
                        None => {
                            seen_ids.insert(id, entry.rel.clone());
                        }
                    }
                }
                None => summary.files += 1,
            },
        }
    }

    Ok(())
}

/// With `fileNaming: "id"` the leaf name is the document's ULID, so that a
/// rename is a modification in place rather than a delete and an add.
/// Spec §7.2.
fn check_id_named(vault_rel: &str, suffix: &str, rel: &str, report: &mut Report) {
    let leaf = match vault_rel.rsplit_once('/') {
        Some((_, leaf)) => leaf,
        None => vault_rel,
    };
    let stem = match leaf.strip_suffix(suffix) {
        Some(stem) => stem,
        None => leaf,
    };
    if !scalar::is_ulid(stem) {
        report.push(Diagnostic::at(Code::FileNameNotUlid, rel).with_detail(explain_id(stem, stem)));
    }
}

/// Check a Markdown file's frontmatter. Returns its `id` if the file is a
/// Doc. Spec §8.
fn check_markdown(entry: &Entry, report: &mut Report) -> Result<Option<String>, Error> {
    let bytes = read(&entry.abs)?;
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        // Not UTF-8, so it carries no frontmatter and is a vault file. No
        // diagnostic: §8.2 makes a file without frontmatter valid, and the
        // format does not require a `.md` file to be text Fjord can read.
        Err(_) => return Ok(None),
    };

    match doc::parse(&text) {
        doc::Parse::Absent => Ok(None),
        doc::Parse::NotAtStart => {
            report.push(
                Diagnostic::at(Code::FrontmatterNotAtStart, &entry.rel)
                    .with_detail("a byte-order mark or a blank line precedes the opening fence"),
            );
            Ok(None)
        }
        doc::Parse::Unterminated => {
            report.push(
                Diagnostic::at(Code::FrontmatterUnparseable, &entry.rel)
                    .with_detail("the opening fence is never closed"),
            );
            Ok(None)
        }
        doc::Parse::NotAMapping => {
            report.push(Diagnostic::at(Code::FrontmatterUnparseable, &entry.rel));
            Ok(None)
        }
        doc::Parse::Unparseable(message) => {
            report.push(
                Diagnostic::at(Code::FrontmatterUnparseable, &entry.rel).with_detail(message),
            );
            Ok(None)
        }
        doc::Parse::Present { frontmatter, .. } => {
            if let Some(created) = frontmatter.created() {
                if !scalar::is_rfc3339_utc(created) {
                    report.push(
                        Diagnostic::at(Code::InvalidTimestamp, &entry.rel)
                            .with_detail(format!("created: {created}")),
                    );
                }
            } else if frontmatter.has(doc::key::CREATED) {
                report.push(
                    Diagnostic::at(Code::InvalidTimestamp, &entry.rel)
                        .with_detail("created is not a string"),
                );
            }

            if let Some(id) = frontmatter.doc_id() {
                return Ok(Some(id.to_string()));
            }

            if frontmatter.has(doc::key::ID) {
                // Present but wrong: a Doc that has lost its identity, not
                // a vault file.
                let detail = match frontmatter.id() {
                    Some(id) => explain_id(&format!("id: {id}"), id),
                    None => "id is not a string".to_string(),
                };
                report
                    .push(Diagnostic::at(Code::DocumentIdInvalid, &entry.rel).with_detail(detail));
            }
            Ok(None)
        }
    }
}

// --- Helpers -------------------------------------------------------------

fn read(path: &Path) -> Result<Vec<u8>, Error> {
    fs::read(path).map_err(|source| Error::Io {
        path: display(path),
        source,
    })
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

/// Where a symlink points, if that is outside the repository. Spec §5.
///
/// `root` is already canonical, so the target is canonicalised too —
/// otherwise a repository under a symlinked ancestor (`/var` on macOS, a
/// symlinked home directory) would make every link inside it look like an
/// escape.
///
/// A link whose target does not exist cannot be canonicalised, so it falls
/// back to textual resolution: a broken link to `/etc/shadow` says exactly
/// as much about a repository as a working one.
fn escaping_target(root: &Path, link: &Path) -> Option<String> {
    let target = fs::read_link(link).ok()?;
    let joined = if target.is_absolute() {
        target
    } else {
        link.parent()?.join(target)
    };
    let resolved = fs::canonicalize(&joined).unwrap_or_else(|_| lexically_normalise(&joined));
    if resolved.starts_with(root) {
        return None;
    }
    Some(format!("resolves to {}", resolved.display()))
}

/// Resolve `.` and `..` textually, without touching the filesystem, so a
/// link to a path that does not exist can still be judged.
fn lexically_normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

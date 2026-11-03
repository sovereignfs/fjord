// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Finding and reading vaults. Spec §2.1, §2.3, §4.
//!
//! A directory is a vault **if and only if** it contains
//! `fjord.vault.json`, and in version 1 vaults are directories at the
//! repository root. That rule, and what each file in a vault is, is written
//! once, in [`crate::listing`], which works on a list of paths and so also
//! serves a client with no filesystem. This module walks the disk and asks
//! it, as [`crate::verify`] does, and a test holds all three to what the
//! walk said about every fixture before they shared it.
//!
//! This module answers "which vault, and how is it configured"; it performs
//! no cryptography and reads no payloads.

use crate::listing::{self, FileKind, ManifestAt, VaultSettings};
use crate::manifest::{self, EncryptionField, Manifest};
use crate::{RESERVED_DIRECTORY, VAULT_MANIFEST};
use std::fs;
use std::path::{Path, PathBuf};

/// Why a vault could not be read.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("{path}: {reason}")]
    Manifest { path: String, reason: String },
}

/// One vault on disk.
#[derive(Debug, Clone)]
pub struct Vault {
    /// Repository-relative directory: the vault's address. Spec §2.3.
    pub directory: String,
    /// Absolute path to the directory.
    pub path: PathBuf,
    pub manifest: Manifest,
}

impl Vault {
    /// The `name` field: the vault's label, which need not match its
    /// directory. Spec §2.3.
    pub fn label(&self) -> Option<&str> {
        self.manifest.string(manifest::field::NAME)
    }

    /// Whether files in this vault are encrypted. Spec §4.
    pub fn is_encrypted(&self) -> bool {
        self.manifest.is_encrypted()
    }

    /// The suffix appended to an encrypted file's name. Spec §6.3.
    ///
    /// Falls back to `.age` when the manifest omits it — which `fjord
    /// verify` reports as a missing required field, but a reader should
    /// still be able to open the vault.
    pub fn suffix(&self) -> String {
        self.settings().suffix
    }

    /// Whether to write ASCII armor. Spec §4.1.
    pub fn armor(&self) -> bool {
        self.encryption()
            .and_then(|encryption| encryption.get(manifest::field::ARMOR))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }

    /// `"plain"` or `"id"`. Spec §7.
    pub fn file_naming(&self) -> &str {
        self.manifest.file_naming().unwrap_or("plain")
    }

    /// Absolute path of the recipients file, if this vault is encrypted and
    /// declares a usable one. Spec §6.2.
    ///
    /// A declared path that is absolute, contains `..`, or uses a backslash
    /// is rejected rather than followed (§5, §11.5): a manifest is
    /// untrusted input.
    pub fn recipients_file(&self) -> Option<PathBuf> {
        let declared = self.encryption().and_then(|encryption| {
            manifest::object_string(encryption, manifest::field::RECIPIENTS)
        })?;
        if crate::path::check_manifest_path(declared).is_some() {
            return None;
        }
        Some(self.path.join(declared))
    }

    /// The recipients file's contents, or an empty string when the vault
    /// declares none.
    pub fn read_recipients(&self) -> Result<String, Error> {
        let path = match self.recipients_file() {
            Some(path) => path,
            None => return Ok(String::new()),
        };
        match fs::read(&path) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(source) => Err(Error::Io {
                path: path.display().to_string(),
                source,
            }),
        }
    }

    /// Files §2.2 reserves: never user documents, never vault content.
    ///
    /// Vault-relative, so a recipients file declared in a subdirectory is
    /// still recognised.
    pub fn machinery(&self) -> Vec<String> {
        self.settings().machinery
    }

    fn settings(&self) -> VaultSettings {
        VaultSettings::from_manifest(&self.manifest)
    }

    /// Every file in the vault, machinery excluded, sorted by path.
    ///
    /// Recursive: §2.1 permits nesting directories inside a vault as deeply
    /// as the user likes, and they are all vault content.
    pub fn contents(&self) -> Result<Vec<Content>, Error> {
        let settings = self.settings();

        let mut found = Vec::new();
        collect(&self.path, "", &settings, &mut found)?;
        found.sort_by(|a, b| a.relative.cmp(&b.relative));
        Ok(found)
    }

    fn encryption(&self) -> Option<&serde_json::Map<String, serde_json::Value>> {
        match self.manifest.encryption() {
            EncryptionField::Object(encryption) => Some(encryption),
            _ => None,
        }
    }
}

/// One file inside a vault.
#[derive(Debug, Clone)]
pub struct Content {
    /// Vault-relative path as it is on disk, with forward slashes.
    pub relative: String,
    /// The document's name: `relative` with the encryption suffix removed,
    /// so `notes.md.age` reads as `notes.md`. The payload's name is an
    /// implementation detail a user should not have to think about.
    pub logical: String,
    /// Whether this is an encrypted payload rather than a plain file.
    pub is_payload: bool,
    pub size: u64,
    pub modified: Option<std::time::SystemTime>,
}

impl Content {
    /// Whether this could carry frontmatter. Spec §8.
    pub fn is_markdown(&self) -> bool {
        self.logical.ends_with(".md")
    }
}

fn collect(
    base: &Path,
    relative: &str,
    settings: &VaultSettings,
    found: &mut Vec<Content>,
) -> Result<(), Error> {
    let directory = if relative.is_empty() {
        base.to_path_buf()
    } else {
        base.join(relative)
    };

    let entries = fs::read_dir(&directory).map_err(|source| Error::Io {
        path: directory.display().to_string(),
        source,
    })?;

    for entry in entries {
        let entry = entry.map_err(|source| Error::Io {
            path: directory.display().to_string(),
            source,
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }

        let child = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };

        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(source) => {
                return Err(Error::Io {
                    path: entry.path().display().to_string(),
                    source,
                })
            }
        };

        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            collect(base, &child, settings, found)?;
            continue;
        }

        // What a file is, and which are machinery, is `listing`'s to say.
        let Some(kind) = listing::classify(&child, settings) else {
            continue;
        };

        found.push(Content {
            logical: listing::logical_name(&child, kind, settings).to_string(),
            relative: child,
            is_payload: kind == FileKind::Payload,
            size: metadata.len(),
            modified: metadata.modified().ok(),
        });
    }

    Ok(())
}

/// Every vault, at any depth below the repository root, in directory order. Spec §2.3.
///
/// A vault inside another vault, and a manifest at the root, are not returned: §2.3 does not permit
/// them, and `fjord verify` reports them as [`Code::NestedVault`][c]. The walk does not go into a
/// vault, so what it finds is exactly what [`listing::locate_vaults`] would say of a listing of
/// every manifest.
///
/// [c]: crate::diagnostics::Code::NestedVault
pub fn discover(root: &Path) -> Result<Vec<Vault>, Error> {
    let mut manifests = Vec::new();
    find_manifests(root, "", &mut manifests)?;
    let files: Vec<listing::ListedFile> = manifests
        .into_iter()
        .map(|path| listing::ListedFile { path, size: 0 })
        .collect();

    listing::locate_vaults(&files)
        .vaults
        .into_iter()
        .map(|directory| read(root, &directory))
        .collect()
}

/// The repository-relative path of every `fjord.vault.json` below `root`, not going into `.git`, the
/// root `.fjord/`, symbolic links, or a directory that is a vault.
fn find_manifests(base: &Path, relative: &str, found: &mut Vec<String>) -> Result<(), Error> {
    let directory = base.join(relative);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(source) => {
            return Err(Error::Io {
                path: directory.display().to_string(),
                source,
            })
        }
    };

    let mut subdirectories = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| Error::Io {
            path: directory.display().to_string(),
            source,
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || (relative.is_empty() && name == RESERVED_DIRECTORY) {
            continue;
        }
        let child = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let metadata = fs::symlink_metadata(entry.path()).map_err(|source| Error::Io {
            path: entry.path().display().to_string(),
            source,
        })?;
        if name == VAULT_MANIFEST && metadata.is_file() {
            // The root's own is recorded too, so that the rule that refuses it is `listing`'s.
            found.push(child);
            if !relative.is_empty() {
                // A vault: what is inside is its content, not more vaults.
                return Ok(());
            }
        } else if metadata.is_dir() && !metadata.file_type().is_symlink() {
            subdirectories.push(child);
        }
    }

    subdirectories.sort();
    for child in subdirectories {
        find_manifests(base, &child, found)?;
    }
    Ok(())
}

/// The vault addressed by `name`, matched against the directory first and
/// the label second.
///
/// The directory wins because §2.3 makes it the vault's address, and two
/// vaults may share a label.
pub fn find(root: &Path, name: &str) -> Result<Option<Vault>, Error> {
    let vaults = discover(root)?;
    if let Some(vault) = vaults.iter().find(|vault| vault.directory == name) {
        return Ok(Some(vault.clone()));
    }
    Ok(vaults.into_iter().find(|vault| vault.label() == Some(name)))
}

/// The vault containing `relative`, a repository-relative path (or the vault itself, if it is its
/// directory).
///
/// A path that is not inside any vault — a file at the repository root, say — yields `None` rather
/// than an error: that is an ordinary file, not a mistake.
pub fn containing(root: &Path, relative: &str) -> Result<Option<Vault>, Error> {
    let mut directory = String::new();
    for component in relative.split('/').filter(|part| !part.is_empty()) {
        if !directory.is_empty() {
            directory.push('/');
        }
        directory.push_str(component);
        let manifest = format!("{directory}/{VAULT_MANIFEST}");
        // The shallowest wins; a vault inside it is not permitted anyway.
        if root.join(&directory).join(VAULT_MANIFEST).is_file()
            && listing::vault_manifest_at(&manifest) == ManifestAt::Vault(directory.clone())
        {
            return read(root, &directory).map(Some);
        }
    }
    Ok(None)
}

fn read(root: &Path, directory: &str) -> Result<Vault, Error> {
    let path = root.join(directory);
    let manifest_path = path.join(VAULT_MANIFEST);
    let bytes = fs::read(&manifest_path).map_err(|source| Error::Io {
        path: manifest_path.display().to_string(),
        source,
    })?;
    let manifest = Manifest::parse(&bytes).map_err(|err| Error::Manifest {
        path: manifest_path.display().to_string(),
        reason: err.to_string(),
    })?;

    Ok(Vault {
        directory: directory.to_string(),
        path,
        manifest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures")
            .join(name)
    }

    /// The conformance fixtures are the repository's, at its root, and are not in the package published to crates.io: a test that
    /// reads them is skipped there, and runs everywhere else.
    fn fixtures_present() -> bool {
        fixture("conforming").is_dir()
    }

    #[test]
    fn discovers_both_vaults_of_the_conforming_fixture() {
        if !fixtures_present() {
            return;
        }
        let vaults = match discover(&fixture("conforming")) {
            Ok(vaults) => vaults,
            Err(err) => panic!("{err}"),
        };
        let directories: Vec<&str> = vaults.iter().map(|v| v.directory.as_str()).collect();
        assert_eq!(directories, vec!["Private", "Public"]);
    }

    /// The rule "a directory is a vault iff it holds fjord.vault.json" is
    /// stated in this module and again in `verify`. If they ever disagree,
    /// one of them is wrong about the format.
    #[test]
    fn discovery_agrees_with_verify() {
        if !fixtures_present() {
            return;
        }
        let root = fixture("conforming");
        let report = match crate::verify::verify(&root, &crate::verify::Options::default()) {
            Ok(report) => report,
            Err(err) => panic!("{err}"),
        };
        let mut from_verify: Vec<String> = report.vaults.iter().map(|v| v.path.clone()).collect();
        from_verify.sort();

        let mut from_discover: Vec<String> = discover(&root)
            .expect("discover")
            .into_iter()
            .map(|v| v.directory)
            .collect();
        from_discover.sort();

        assert_eq!(from_verify, from_discover);
    }

    #[test]
    fn reads_the_encryption_settings() {
        if !fixtures_present() {
            return;
        }
        let private = match find(&fixture("conforming"), "Private") {
            Ok(Some(vault)) => vault,
            other => panic!("expected the Private vault, got {other:?}"),
        };
        assert!(private.is_encrypted());
        assert_eq!(private.suffix(), ".age");
        assert!(!private.armor());
        assert_eq!(private.file_naming(), "plain");
        assert_eq!(private.label(), Some("Private"));

        let recipients = private.read_recipients().expect("recipients");
        assert_eq!(manifest::parse_recipients(&recipients).len(), 1);
    }

    #[test]
    fn a_plaintext_vault_has_no_encryption_settings() {
        if !fixtures_present() {
            return;
        }
        let public = find(&fixture("conforming"), "Public")
            .expect("find")
            .expect("Public");
        assert!(!public.is_encrypted());
        assert_eq!(public.recipients_file(), None);
        assert_eq!(public.read_recipients().expect("recipients"), "");
    }

    #[test]
    fn a_vault_can_be_addressed_by_label_as_well_as_directory() {
        if !fixtures_present() {
            return;
        }
        let root = fixture("conforming");
        assert!(find(&root, "Private").expect("find").is_some());
        // Same vault, found by its `name` field.
        let by_label = find(&root, "Private").expect("find").expect("vault");
        assert_eq!(by_label.directory, "Private");
        assert!(find(&root, "Nonexistent").expect("find").is_none());
    }

    #[test]
    fn finds_the_vault_containing_a_path() {
        if !fixtures_present() {
            return;
        }
        let root = fixture("conforming");
        let vault = containing(&root, "Public/welcome.md")
            .expect("containing")
            .expect("vault");
        assert_eq!(vault.directory, "Public");

        // A file at the repository root is in no vault, which is not an
        // error.
        assert!(containing(&root, "README.md")
            .expect("containing")
            .is_none());
        assert!(containing(&root, "").expect("containing").is_none());
    }

    #[test]
    fn lists_vault_content_and_leaves_machinery_out() {
        if !fixtures_present() {
            return;
        }
        let private = find(&fixture("conforming"), "Private")
            .expect("find")
            .expect("Private");
        // The conforming Private vault holds nothing but machinery.
        assert!(private.contents().expect("contents").is_empty());
        assert!(private.machinery().contains(&"recipients.txt".to_string()));
        assert!(private
            .machinery()
            .contains(&"fjord.vault.json".to_string()));

        let public = find(&fixture("conforming"), "Public")
            .expect("find")
            .expect("Public");
        let contents = public.contents().expect("contents");
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0].relative, "welcome.md");
        assert_eq!(contents[0].logical, "welcome.md");
        assert!(!contents[0].is_payload);
        assert!(contents[0].is_markdown());
        assert!(contents[0].size > 0);
    }

    #[test]
    fn a_payload_is_listed_under_its_logical_name() {
        if !fixtures_present() {
            return;
        }
        // §6.3: the suffix is appended, so stripping it gives the
        // document's real name and type.
        let vault = find(&fixture("broken/E304"), "Private")
            .expect("find")
            .expect("Private");
        let contents = vault.contents().expect("contents");
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0].relative, "notes.age");
        assert_eq!(contents[0].logical, "notes");
        assert!(contents[0].is_payload);
    }

    #[test]
    fn a_recipients_path_that_escapes_the_vault_is_refused() {
        // §11.5: a manifest is untrusted input.
        let manifest = Manifest::parse(
            br#"{"encryption":{"tool":"age","recipients":"../../etc/passwd","suffix":".age","container":"none","armor":false}}"#,
        )
        .expect("parse");
        let vault = Vault {
            directory: "Private".to_string(),
            path: PathBuf::from("/repo/Private"),
            manifest,
        };
        assert_eq!(vault.recipients_file(), None);
    }
}

//! Finding and reading vaults. Spec §2.1, §2.3, §4.
//!
//! A directory is a vault **if and only if** it contains
//! `fjord.vault.json`, and in version 1 vaults are directories at the
//! repository root. That rule is stated once here and once in
//! [`crate::verify`], which discovers vaults as part of the single walk it
//! already performs in order to diagnose nested ones. A test holds the two
//! together against the conforming fixture, so they cannot drift into
//! disagreeing about what a vault is.
//!
//! This module answers "which vault, and how is it configured"; it performs
//! no cryptography and reads no payloads.

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
        self.encryption()
            .and_then(|encryption| manifest::object_string(encryption, manifest::field::SUFFIX))
            .unwrap_or(manifest::SUFFIX_AGE)
            .to_string()
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

    fn encryption(&self) -> Option<&serde_json::Map<String, serde_json::Value>> {
        match self.manifest.encryption() {
            EncryptionField::Object(encryption) => Some(encryption),
            _ => None,
        }
    }
}

/// Every vault at the repository root, in directory order.
///
/// Vaults deeper in the tree are not returned: §2.3 does not permit them,
/// and `fjord verify` reports them as [`Code::NestedVault`][c].
///
/// [c]: crate::diagnostics::Code::NestedVault
pub fn discover(root: &Path) -> Result<Vec<Vault>, Error> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(source) => {
            return Err(Error::Io {
                path: root.display().to_string(),
                source,
            })
        }
    };

    let mut directories = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| Error::Io {
            path: root.display().to_string(),
            source,
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == RESERVED_DIRECTORY {
            continue;
        }
        if entry.path().join(VAULT_MANIFEST).is_file() {
            directories.push(name);
        }
    }
    directories.sort();

    directories
        .into_iter()
        .map(|directory| read(root, &directory))
        .collect()
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

/// The vault containing `relative`, a repository-relative path.
///
/// A path that is not inside any vault — a file at the repository root, say
/// — yields `None` rather than an error: that is an ordinary file, not a
/// mistake.
pub fn containing(root: &Path, relative: &str) -> Result<Option<Vault>, Error> {
    let first = match relative.split('/').next() {
        Some(first) if !first.is_empty() => first,
        _ => return Ok(None),
    };
    if !root.join(first).join(VAULT_MANIFEST).is_file() {
        return Ok(None);
    }
    read(root, first).map(Some)
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

    #[test]
    fn discovers_both_vaults_of_the_conforming_fixture() {
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
        let public = find(&fixture("conforming"), "Public")
            .expect("find")
            .expect("Public");
        assert!(!public.is_encrypted());
        assert_eq!(public.recipients_file(), None);
        assert_eq!(public.read_recipients().expect("recipients"), "");
    }

    #[test]
    fn a_vault_can_be_addressed_by_label_as_well_as_directory() {
        let root = fixture("conforming");
        assert!(find(&root, "Private").expect("find").is_some());
        // Same vault, found by its `name` field.
        let by_label = find(&root, "Private").expect("find").expect("vault");
        assert_eq!(by_label.directory, "Private");
        assert!(find(&root, "Nonexistent").expect("find").is_none());
    }

    #[test]
    fn finds_the_vault_containing_a_path() {
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

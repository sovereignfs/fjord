// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Vaults and their files, from a listing of paths. Spec §2.1–§2.3, §4, §6.3.
//!
//! A client with no filesystem (a web page that has read a repository's tree from a git host, a
//! phone) has a list of paths and sizes, and fetches a few small files on demand. Everything it
//! needs to know about the *shape* of the repository follows from that list and the vault
//! manifests' bytes: which directories are vaults, which manifests are where §2.3 does not allow
//! them, and what each file in a vault is. This module is that and nothing more: pure, with no
//! filesystem, no `std::path` and no I/O, so it compiles to WebAssembly.
//!
//! It is also the **only** place those rules are written. The filesystem walk the CLI performs
//! ([`crate::vault`], [`crate::verify`]) does not restate them: it lists the files it finds and asks
//! this module, so the web client and the CLI cannot disagree about what a vault is. A test holds
//! both to what the walk said about every fixture before this module existed
//! (`tests/fixtures/discovery.json`).
//!
//! # What a listing cannot say
//!
//! Whether a Markdown file is a Doc (has an `id` in its frontmatter) needs its contents, not its
//! name. A listing classifies by name only: a file that *could* carry frontmatter is
//! [`FileKind::Markdown`], and a client reads it, lazily, to find out.

use crate::manifest::{self, EncryptionField, Manifest};
use crate::{RESERVED_DIRECTORY, VAULT_MANIFEST};
use std::collections::BTreeMap;

/// One file in a listing: a repository-relative path with forward slashes, and its size in bytes.
///
/// A listing is of files, not directories; a directory exists because a file is inside it. A
/// symbolic link is a file here, as it is in git.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedFile {
    pub path: String,
    pub size: u64,
}

/// Whether a path is invisible to the format: anything inside `.git`, and anything under the root
/// `.fjord/`, which §2.2 reserves for client machinery to be ignored and preserved (§12).
fn ignored(path: &str) -> bool {
    let mut parts = path.split('/');
    if parts.next() == Some(RESERVED_DIRECTORY) && path.contains('/') {
        return true;
    }
    path.split('/').any(|part| part == ".git")
}

/// What a path says about vaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestAt {
    /// Not a vault manifest.
    NotAManifest,
    /// The manifest of the vault in this directory at the repository root. §2.1, §2.3.
    Vault(String),
    /// A vault manifest where §2.3 does not permit one: at the repository root (which would make the
    /// root a vault), or deeper than one directory down. Holds what to report it at: the file for the
    /// first, the directory for the second.
    Nested(String),
}

/// Whether `path` is a vault manifest, and if so whether it is where one may be.
pub fn vault_manifest_at(path: &str) -> ManifestAt {
    if ignored(path) {
        return ManifestAt::NotAManifest;
    }
    let (parent, name) = match path.rsplit_once('/') {
        Some((parent, name)) => (Some(parent), name),
        None => (None, path),
    };
    if name != VAULT_MANIFEST {
        return ManifestAt::NotAManifest;
    }
    match parent {
        None => ManifestAt::Nested(path.to_string()),
        Some(parent) if parent.contains('/') => ManifestAt::Nested(parent.to_string()),
        Some(parent) => ManifestAt::Vault(parent.to_string()),
    }
}

/// The vaults in a listing, and the manifests that are where they should not be.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Located {
    /// Directories at the repository root that hold a vault manifest, sorted.
    pub vaults: Vec<String>,
    /// Where nested vault manifests are, in path order. §2.3 does not permit them in version 1.
    pub nested: Vec<String>,
}

/// Which directories are vaults. A directory is a vault **if and only if** it contains
/// `fjord.vault.json`, and in version 1 vaults are directories at the repository root. §2.1, §2.3.
pub fn locate_vaults(files: &[ListedFile]) -> Located {
    let mut sorted: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    sorted.sort_unstable();

    let mut located = Located::default();
    for path in sorted {
        match vault_manifest_at(path) {
            ManifestAt::NotAManifest => {}
            ManifestAt::Vault(directory) => located.vaults.push(directory),
            ManifestAt::Nested(at) => located.nested.push(at),
        }
    }
    located.vaults.sort();
    located.vaults.dedup();
    located
}

/// The repository-relative paths of the manifests a client has to read to go on: the vault manifests
/// at the root. (`fjord.json` is the repository's own, and is always at `fjord.json`.)
pub fn manifest_paths(files: &[ListedFile]) -> Vec<String> {
    locate_vaults(files)
        .vaults
        .into_iter()
        .map(|directory| format!("{directory}/{VAULT_MANIFEST}"))
        .collect()
}

/// What a vault's manifest says that decides what its files are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultSettings {
    /// Whether the files are encrypted. §4. An `encryption` that is not an object is not encryption,
    /// as far as reading goes: the caller will already have reported it.
    pub encrypted: bool,
    /// The suffix of an encrypted payload. §6.3. `.age` when the manifest omits it, which `verify`
    /// reports as a missing field, but a reader should still be able to open the vault.
    pub suffix: String,
    /// Files §2.2 reserves, vault-relative: never user documents and never vault content. The
    /// manifest, `.gitignore`, and the recipients file if the manifest declares a usable path (a
    /// manifest is untrusted input: an absolute path, `..` or a backslash is not followed, §5, §11.5).
    pub machinery: Vec<String>,
}

impl VaultSettings {
    pub fn from_manifest(manifest: &Manifest) -> Self {
        let encryption = match manifest.encryption() {
            EncryptionField::Object(object) => Some(object),
            _ => None,
        };
        let suffix = encryption
            .and_then(|object| manifest::object_string(object, manifest::field::SUFFIX))
            .unwrap_or(manifest::SUFFIX_AGE)
            .to_string();

        let mut machinery = vec![VAULT_MANIFEST.to_string(), ".gitignore".to_string()];
        if let Some(declared) = encryption
            .and_then(|object| manifest::object_string(object, manifest::field::RECIPIENTS))
        {
            if crate::path::check_manifest_path(declared).is_none() {
                machinery.push(declared.to_string());
            }
        }

        Self {
            encrypted: encryption.is_some(),
            suffix,
            machinery,
        }
    }
}

/// What a file in a vault is, by its name. Machinery is not listed: it is not content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// An encrypted payload: a file in an encrypted vault that ends in the suffix. §6.3.
    Payload,
    /// A file in an encrypted vault that is **not** a payload: plaintext where plaintext must never
    /// be (invariant 1). Reported as [`crate::diagnostics::Code::PlaintextInEncryptedVault`].
    Stray,
    /// A file in a plaintext vault that ends in the encryption suffix. Reported as
    /// [`crate::diagnostics::Code::EncryptedFileInPlaintextVault`].
    MisplacedPayload,
    /// A file in a plaintext vault that could carry frontmatter (`.md`). Whether it is a Doc is for
    /// its contents to say. §8.
    Markdown,
    /// Any other file in a plaintext vault.
    Other,
}

/// What a vault-relative path is, or `None` if it is machinery.
pub fn classify(relative: &str, settings: &VaultSettings) -> Option<FileKind> {
    if settings
        .machinery
        .iter()
        .any(|reserved| reserved == relative)
    {
        return None;
    }
    let has_suffix = relative.ends_with(settings.suffix.as_str());
    Some(match (settings.encrypted, has_suffix) {
        (true, true) => FileKind::Payload,
        (true, false) => FileKind::Stray,
        (false, true) => FileKind::MisplacedPayload,
        (false, false) if relative.ends_with(".md") => FileKind::Markdown,
        (false, false) => FileKind::Other,
    })
}

/// The name a person knows a file by: a payload without its suffix (`notes.md.age` is `notes.md`);
/// anything else as it is. §6.3.
pub fn logical_name<'a>(relative: &'a str, kind: FileKind, settings: &VaultSettings) -> &'a str {
    match kind {
        FileKind::Payload => relative
            .strip_suffix(settings.suffix.as_str())
            .unwrap_or(relative),
        _ => relative,
    }
}

/// One file of a vault, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedFile {
    /// Repository-relative.
    pub path: String,
    /// Relative to the vault's directory.
    pub relative: String,
    /// See [`logical_name`].
    pub logical: String,
    pub kind: FileKind,
    pub size: u64,
}

/// Every file of the vault in `directory`, machinery left out, sorted by path. A vault is nested
/// directories as deep as the user likes (§2.1), and they are all vault content.
pub fn classify_vault(
    directory: &str,
    settings: &VaultSettings,
    files: &[ListedFile],
) -> Vec<ClassifiedFile> {
    let prefix = format!("{directory}/");
    let mut found: Vec<ClassifiedFile> = files
        .iter()
        .filter(|file| !ignored(&file.path))
        .filter_map(|file| {
            let relative = file.path.strip_prefix(&prefix)?;
            let kind = classify(relative, settings)?;
            Some(ClassifiedFile {
                path: file.path.clone(),
                relative: relative.to_string(),
                logical: logical_name(relative, kind, settings).to_string(),
                kind,
                size: file.size,
            })
        })
        .collect();
    found.sort_by(|a, b| a.relative.cmp(&b.relative));
    found
}

/// A vault found in a listing.
#[derive(Debug, Clone)]
pub struct VaultListing {
    /// Repository-relative directory: the vault's address. §2.3.
    pub directory: String,
    /// The parsed manifest, or why it could not be read (it was not provided, or is not JSON). A vault
    /// whose manifest cannot be read has no known content, as in `verify`: whether its files are
    /// encrypted is the manifest's to say.
    pub manifest: Result<Manifest, String>,
    /// What the manifest decides about the files; absent when the manifest could not be read.
    pub settings: Option<VaultSettings>,
    pub files: Vec<ClassifiedFile>,
}

/// What a listing says about a repository's vaults.
#[derive(Debug, Clone, Default)]
pub struct Discovery {
    /// The vaults at the repository root, sorted by directory.
    pub vaults: Vec<VaultListing>,
    /// Vault manifests where they may not be. See [`ManifestAt::Nested`].
    pub nested: Vec<String>,
}

impl Discovery {
    /// The vault a repository-relative path is inside, if any. A file at the root is in no vault,
    /// which is not a mistake.
    pub fn vault_containing(&self, path: &str) -> Option<&VaultListing> {
        let first = path.split('/').next().filter(|first| !first.is_empty())?;
        self.vaults.iter().find(|vault| vault.directory == first)
    }
}

/// The vaults of a repository and what is in them, from its listing and the bytes of its vault
/// manifests, keyed by repository-relative path (see [`manifest_paths`]). Pure: nothing is read, so a
/// client fetches the manifests it needs and calls this.
pub fn discover(files: &[ListedFile], manifests: &BTreeMap<String, Vec<u8>>) -> Discovery {
    let located = locate_vaults(files);
    let vaults = located
        .vaults
        .into_iter()
        .map(|directory| {
            let at = format!("{directory}/{VAULT_MANIFEST}");
            let manifest = match manifests.get(&at) {
                Some(bytes) => Manifest::parse(bytes).map_err(|err| err.to_string()),
                None => Err(format!("{at}: its bytes were not provided")),
            };
            let settings = manifest.as_ref().ok().map(VaultSettings::from_manifest);
            let files = settings
                .as_ref()
                .map(|settings| classify_vault(&directory, settings, files))
                .unwrap_or_default();
            VaultListing {
                directory,
                manifest,
                settings,
                files,
            }
        })
        .collect();
    Discovery {
        vaults,
        nested: located.nested,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(paths: &[&str]) -> Vec<ListedFile> {
        paths
            .iter()
            .map(|path| ListedFile {
                path: (*path).to_string(),
                size: 10,
            })
            .collect()
    }

    const PLAIN: &[u8] = br#"{"id":"01J8Z3K9T2V4W5X6Y7Z8A9B0C1","name":"Notes","version":1,"createdAt":"2026-01-01T00:00:00Z","fileNaming":"plain","encryption":null}"#;
    const ENCRYPTED: &[u8] =
        br#"{"name":"Private","encryption":{"tool":"age","recipients":"keys/recipients.txt","suffix":".age","container":"none","armor":false}}"#;

    #[test]
    fn a_directory_is_a_vault_if_and_only_if_it_holds_a_vault_manifest() {
        let files = listed(&[
            "fjord.json",
            "Notes/fjord.vault.json",
            "Notes/a.md",
            "Plain/b.md",
            "README.md",
        ]);
        let located = locate_vaults(&files);
        assert_eq!(located.vaults, ["Notes"]);
        assert!(located.nested.is_empty());
    }

    #[test]
    fn vaults_come_back_sorted_by_directory_whatever_order_they_were_listed_in() {
        let files = listed(&[
            "B/fjord.vault.json",
            "A-b/fjord.vault.json",
            "A/fjord.vault.json",
        ]);
        assert_eq!(locate_vaults(&files).vaults, ["A", "A-b", "B"]);
    }

    #[test]
    fn a_manifest_at_the_root_or_deeper_than_one_directory_is_nested_and_is_not_a_vault() {
        let files = listed(&[
            "fjord.vault.json",
            "Notes/fjord.vault.json",
            "Notes/Inner/fjord.vault.json",
            "A/B/C/fjord.vault.json",
        ]);
        let located = locate_vaults(&files);
        assert_eq!(located.vaults, ["Notes"]);
        // The root one is reported at the file, the deeper ones at their directory, in path order.
        assert_eq!(located.nested, ["A/B/C", "Notes/Inner", "fjord.vault.json"]);
    }

    #[test]
    fn the_git_directory_and_the_roots_fjord_directory_are_not_part_of_the_repository() {
        let files = listed(&[
            ".git/x/fjord.vault.json",
            ".fjord/fjord.vault.json",
            ".fjord/cache/fjord.vault.json",
            "V/fjord.vault.json",
            "V/.git/hooks",
        ]);
        let located = locate_vaults(&files);
        assert_eq!(located.vaults, ["V"]);
        assert!(located.nested.is_empty());
        // `.fjord` is only reserved at the root: a vault may have a directory of that name.
        assert_eq!(
            vault_manifest_at("V/.fjord/fjord.vault.json"),
            ManifestAt::Nested("V/.fjord".to_string())
        );
        assert_eq!(vault_manifest_at(".fjord"), ManifestAt::NotAManifest);
    }

    #[test]
    fn the_manifests_to_read_are_the_roots_vaults() {
        let files = listed(&[
            "fjord.json",
            "B/fjord.vault.json",
            "A/fjord.vault.json",
            "A/deep/fjord.vault.json",
        ]);
        assert_eq!(
            manifest_paths(&files),
            ["A/fjord.vault.json", "B/fjord.vault.json"]
        );
    }

    #[test]
    fn settings_come_from_the_manifest() {
        let plain = VaultSettings::from_manifest(&Manifest::parse(PLAIN).unwrap());
        assert!(!plain.encrypted);
        assert_eq!(plain.suffix, ".age");
        assert_eq!(plain.machinery, ["fjord.vault.json", ".gitignore"]);

        let encrypted = VaultSettings::from_manifest(&Manifest::parse(ENCRYPTED).unwrap());
        assert!(encrypted.encrypted);
        assert_eq!(
            encrypted.machinery,
            ["fjord.vault.json", ".gitignore", "keys/recipients.txt"]
        );
    }

    #[test]
    fn a_recipients_path_that_escapes_the_vault_is_not_machinery() {
        // §11.5: a manifest is untrusted input.
        for declared in ["../../etc/passwd", "/etc/passwd", "a\\b"] {
            let text = format!(
                r#"{{"encryption":{{"tool":"age","recipients":{declared:?},"suffix":".age","container":"none","armor":false}}}}"#
            );
            let settings = VaultSettings::from_manifest(&Manifest::parse(text.as_bytes()).unwrap());
            assert_eq!(
                settings.machinery,
                ["fjord.vault.json", ".gitignore"],
                "{declared}"
            );
        }
    }

    #[test]
    fn an_encryption_that_is_not_an_object_is_not_encryption() {
        for text in [r#"{"encryption":null}"#, r#"{"encryption":5}"#, r#"{}"#] {
            assert!(
                !VaultSettings::from_manifest(&Manifest::parse(text.as_bytes()).unwrap()).encrypted,
                "{text}"
            );
        }
    }

    #[test]
    fn files_are_classified_by_name_and_by_the_vault_they_are_in() {
        let plain = VaultSettings::from_manifest(&Manifest::parse(PLAIN).unwrap());
        assert_eq!(classify("a.md", &plain), Some(FileKind::Markdown));
        assert_eq!(classify("deep/er/a.md", &plain), Some(FileKind::Markdown));
        assert_eq!(classify("photo.png", &plain), Some(FileKind::Other));
        assert_eq!(
            classify("a.md.age", &plain),
            Some(FileKind::MisplacedPayload)
        );
        assert_eq!(classify(".gitignore", &plain), None);
        assert_eq!(classify("fjord.vault.json", &plain), None);

        let encrypted = VaultSettings::from_manifest(&Manifest::parse(ENCRYPTED).unwrap());
        assert_eq!(classify("a.md.age", &encrypted), Some(FileKind::Payload));
        assert_eq!(classify("a.md", &encrypted), Some(FileKind::Stray));
        assert_eq!(classify("keys/recipients.txt", &encrypted), None);
        // Machinery is exactly the declared path, not a file of the same name elsewhere.
        assert_eq!(
            classify("other/recipients.txt", &encrypted),
            Some(FileKind::Stray)
        );
    }

    #[test]
    fn a_payload_is_known_by_its_name_without_the_suffix() {
        let encrypted = VaultSettings::from_manifest(&Manifest::parse(ENCRYPTED).unwrap());
        assert_eq!(
            logical_name("notes.md.age", FileKind::Payload, &encrypted),
            "notes.md"
        );
        assert_eq!(
            logical_name("notes.md", FileKind::Stray, &encrypted),
            "notes.md"
        );
        let plain = VaultSettings::from_manifest(&Manifest::parse(PLAIN).unwrap());
        assert_eq!(
            logical_name("a.md.age", FileKind::MisplacedPayload, &plain),
            "a.md.age"
        );
    }

    #[test]
    fn a_vaults_files_are_everything_under_it_but_machinery_sorted() {
        let files = listed(&[
            "Notes/z.md",
            "Notes/a.md",
            "Notes/sub/b.md",
            "Notes/.gitignore",
            "Notes/fjord.vault.json",
            "Other/c.md",
            "Notes.md",
        ]);
        let settings = VaultSettings::from_manifest(&Manifest::parse(PLAIN).unwrap());
        let found = classify_vault("Notes", &settings, &files);
        assert_eq!(
            found
                .iter()
                .map(|f| f.relative.as_str())
                .collect::<Vec<_>>(),
            ["a.md", "sub/b.md", "z.md"]
        );
        assert_eq!(found[1].path, "Notes/sub/b.md");
        assert!(found
            .iter()
            .all(|f| f.kind == FileKind::Markdown && f.size == 10));
    }

    #[test]
    fn discovery_puts_it_together_from_a_listing_and_the_manifests_bytes() {
        let files = listed(&[
            "fjord.json",
            "Notes/fjord.vault.json",
            "Notes/a.md",
            "Secret/fjord.vault.json",
            "Secret/x.md.age",
            "Secret/keys/recipients.txt",
        ]);
        let mut manifests = BTreeMap::new();
        manifests.insert("Notes/fjord.vault.json".to_string(), PLAIN.to_vec());
        manifests.insert("Secret/fjord.vault.json".to_string(), ENCRYPTED.to_vec());

        let found = discover(&files, &manifests);
        let directories: Vec<_> = found.vaults.iter().map(|v| v.directory.as_str()).collect();
        assert_eq!(directories, ["Notes", "Secret"]);
        assert_eq!(found.vaults[0].files.len(), 1);
        assert_eq!(
            found.vaults[1]
                .files
                .iter()
                .map(|f| (f.relative.as_str(), f.logical.as_str(), f.kind))
                .collect::<Vec<_>>(),
            [("x.md.age", "x.md", FileKind::Payload)]
        );
        assert_eq!(
            found
                .vault_containing("Secret/x.md.age")
                .map(|v| v.directory.as_str()),
            Some("Secret")
        );
        assert!(found.vault_containing("README.md").is_none());
        assert!(found.vault_containing("").is_none());
    }

    #[test]
    fn a_vault_whose_manifest_is_missing_or_unreadable_is_listed_with_no_known_content() {
        let files = listed(&[
            "A/fjord.vault.json",
            "A/a.md",
            "B/fjord.vault.json",
            "B/b.md",
        ]);
        let mut manifests = BTreeMap::new();
        manifests.insert("B/fjord.vault.json".to_string(), b"not json".to_vec());
        let found = discover(&files, &manifests);
        for vault in &found.vaults {
            assert!(vault.manifest.is_err(), "{}", vault.directory);
            assert!(vault.settings.is_none());
            assert!(vault.files.is_empty());
        }
    }
}

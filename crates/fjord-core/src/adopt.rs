// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Making a Fjord repository of a directory that already has files. Spec §2.3, §3.1, §6.6; RFC 0002.
//!
//! [`scaffold::plan_setup`] adds a vault to a repository that is not a Fjord one; this adds the vaults a
//! person **chooses** (any directories, at any depth), of any kind, and keeps its hands off everything
//! else. Pure, like the rest of the scaffolding: the caller says what is there ([`plan_adopt`]'s `existing`
//! and the text of the two files it may add to), where the identifiers come from, and does the writing.
//!
//! # What it never does
//!
//! - It never changes, renames or moves a file that is there. Every file of the plan is new, but for
//!   `.gitattributes` and `.gitignore`, which only ever gain lines at their end ([`FileChange::Append`]).
//! - It never writes a starter note or a `README.md`: a person's repository does not need ours.
//! - It never lets plaintext into an encrypted vault silently. Choosing to encrypt a directory that
//!   already holds files is [`AdoptedVault::encrypted`] with [`PlannedVault::holds_files`] set, and the
//!   caller must then begin a checkout (spec §6.6) before it writes anything: the files are in the clear
//!   until `fjord encrypt <vault>` ends it, and git's history keeps every version already committed.

use crate::manifest::{field, Kind};
use crate::path::{check_component, to_nfc};
use crate::scaffold::{
    fold, pretty, root_names, vault_files, FileChange, SetupFile, SiteEngine, GITIGNORE,
    SETUP_GITATTRIBUTES,
};
use crate::{FORMAT_VERSION, REPOSITORY_MANIFEST, VAULT_MANIFEST};
use serde_json::json;

/// What the repository is for, as far as adopting it decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdoptKind {
    /// Any number of vaults, each plaintext or encrypted. No `kind` is written (spec §3.1).
    Drive,
    /// Exactly one vault, plaintext or encrypted (by id, in a tar container, spec §7.2).
    Journal,
    /// Exactly one plaintext vault, where the engine already reads its content.
    Ssg(SiteEngine),
}

/// One directory to make a vault of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdoptedVault {
    /// The directory, relative to the root with forward slashes, at any depth (`notes`, `src/content`). Its
    /// last component is the vault's display name.
    pub path: String,
    /// Whether the vault is to be encrypted. With files in it already, this is the choice that needs a
    /// checkout ([`PlannedVault::holds_files`]).
    pub encrypted: bool,
}

/// What to adopt.
#[derive(Debug, Clone)]
pub struct Adoption {
    /// `fjord.json`'s `name`. Spec §3.
    pub repository_name: String,
    /// Tool and version, recorded in `generator`. Spec §3.
    pub generator: String,
    pub kind: AdoptKind,
    pub vaults: Vec<AdoptedVault>,
}

/// A vault the plan makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedVault {
    pub path: String,
    pub id: String,
    pub encrypted: bool,
    /// The directory already has files in it. For an encrypted vault, that is plaintext inside it that a
    /// checkout (spec §6.6) has to account for before anything is written.
    pub holds_files: bool,
}

/// Everything [`plan_adopt`] adds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdoptPlan {
    pub files: Vec<SetupFile>,
    pub repository_id: String,
    pub vaults: Vec<PlannedVault>,
    pub created_at: String,
}

/// Why a directory cannot be adopted as asked.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdoptError {
    /// There is a `fjord.json`: this is a Fjord repository already (a broken one is not ours to overwrite).
    #[error("this directory already has a fjord.json")]
    AlreadyFjord,
    #[error("a {kind} has {rule} (spec §3.1)")]
    VaultCount {
        kind: &'static str,
        rule: &'static str,
    },
    #[error("a site's content is never encrypted: it is published (spec §3.1)")]
    EncryptedSite,
    #[error("\"{path}\" cannot be a vault: {reason}")]
    InvalidVaultPath { path: String, reason: String },
    #[error("\"{inner}\" is inside \"{outer}\", and no vault is inside another (spec §2.3)")]
    NestedVaults { outer: String, inner: String },
    #[error("\"{0}\" is chosen twice (names are compared without regard to case)")]
    DuplicateVault(String),
    #[error("\"{0}\" is already a vault")]
    VaultExists(String),
    #[error("\"{0}\" is there already, and the vault would need it")]
    FileTaken(String),
    /// A file named for a vault path exists: it is not a directory.
    #[error("\"{0}\" is a file, not a directory")]
    NotADirectory(String),
    #[error(".gitattributes is there but its text was not supplied")]
    GitattributesNotRead,
    #[error(".gitignore is there but its text was not supplied")]
    GitignoreNotRead,
    #[error("{needed} identifiers are needed for the vaults and only {given} were supplied")]
    TooFewIds { needed: usize, given: usize },
}

impl AdoptError {
    /// A stable name for the kind of failure, for a caller that reports it.
    pub fn code(&self) -> &'static str {
        match self {
            AdoptError::AlreadyFjord => "already_fjord",
            AdoptError::VaultCount { .. } => "vault_count",
            AdoptError::EncryptedSite => "encrypted_site",
            AdoptError::InvalidVaultPath { .. } => "invalid_vault_path",
            AdoptError::NestedVaults { .. } => "nested_vaults",
            AdoptError::DuplicateVault(_) => "duplicate_vault",
            AdoptError::VaultExists(_) => "vault_exists",
            AdoptError::FileTaken(_) => "file_taken",
            AdoptError::NotADirectory(_) => "not_a_directory",
            AdoptError::GitattributesNotRead => "gitattributes_not_read",
            AdoptError::GitignoreNotRead => "gitignore_not_read",
            AdoptError::TooFewIds { .. } => "too_few_ids",
        }
    }
}

/// A site an engine's files give away: which engine, and the folder it reads its content from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedSite {
    pub engine: SiteEngine,
    /// Where the engine keeps its content: the directory to adopt as the vault.
    pub content: &'static str,
}

/// The static site a repository already is, from the paths in it: `astro.config.*` at the root means
/// Astro, whose content is `src/content`, and `_config.yml` (or `.yaml`, `.toml`) means Jekyll, whose
/// posts are `_posts`. `None` for anything else, including a site whose engine this build does not make.
pub fn detect_site<S: AsRef<str>>(existing: &[S]) -> Option<DetectedSite> {
    let at_root = |predicate: &dyn Fn(&str) -> bool| {
        existing.iter().any(|path| {
            let path = path.as_ref();
            !path.contains('/') && predicate(path)
        })
    };
    if at_root(&|name| name.starts_with("astro.config.")) {
        return Some(DetectedSite {
            engine: SiteEngine::Astro,
            content: "src/content",
        });
    }
    if at_root(&|name| matches!(name, "_config.yml" | "_config.yaml" | "_config.toml")) {
        return Some(DetectedSite {
            engine: SiteEngine::Jekyll,
            content: "_posts",
        });
    }
    None
}

/// Decide what to add to a directory to make it a Fjord repository of a kind. Pure.
///
/// `existing` is the path of every file in the directory (directories need not be listed); `gitattributes`
/// and `gitignore` are the text of those two files if they are there. `vault_ids` supplies one identifier
/// for each vault, in order, and `repository_id` and `created_at` are the caller's, as for every plan.
///
/// The plan is `fjord.json`; each vault's `fjord.vault.json` (and, for an encrypted vault, its recipients
/// file and its plaintext-guard `.gitignore`, spec §6.5); spec §9's merge guard in `.gitattributes`; and, if
/// anything is encrypted, the `.fjord/local/` line in the root `.gitignore` that a checkout's record needs.
pub fn plan_adopt<S: AsRef<str>>(
    adoption: &Adoption,
    repository_id: &str,
    created_at: &str,
    vault_ids: &[String],
    existing: &[S],
    gitattributes: Option<&str>,
    gitignore: Option<&str>,
) -> Result<AdoptPlan, AdoptError> {
    let roots = root_names(existing);
    if roots.iter().any(|name| fold(name) == REPOSITORY_MANIFEST) {
        return Err(AdoptError::AlreadyFjord);
    }

    // The kind's rules (spec §3.1), before anything is looked at.
    let count = adoption.vaults.len();
    match adoption.kind {
        AdoptKind::Drive if count == 0 => {
            return Err(AdoptError::VaultCount {
                kind: "drive",
                rule: "at least one vault here",
            })
        }
        AdoptKind::Journal if count != 1 => {
            return Err(AdoptError::VaultCount {
                kind: "journal",
                rule: "exactly one vault",
            })
        }
        AdoptKind::Ssg(_) if count != 1 => {
            return Err(AdoptError::VaultCount {
                kind: "site",
                rule: "exactly one vault",
            })
        }
        _ => {}
    }
    if matches!(adoption.kind, AdoptKind::Ssg(_)) && adoption.vaults.iter().any(|v| v.encrypted) {
        return Err(AdoptError::EncryptedSite);
    }
    if vault_ids.len() < count {
        return Err(AdoptError::TooFewIds {
            needed: count,
            given: vault_ids.len(),
        });
    }

    // Each path, checked as a path on its own.
    let mut paths: Vec<String> = Vec::new();
    for vault in &adoption.vaults {
        paths.push(check_vault_path(&vault.path)?);
    }
    // And against each other, and against what is there.
    for (index, path) in paths.iter().enumerate() {
        for other in &paths[..index] {
            let (a, b) = (fold(path), fold(other));
            if a == b {
                return Err(AdoptError::DuplicateVault(path.clone()));
            }
            if b.starts_with(&format!("{a}/")) {
                return Err(AdoptError::NestedVaults {
                    outer: path.clone(),
                    inner: other.clone(),
                });
            }
            if a.starts_with(&format!("{b}/")) {
                return Err(AdoptError::NestedVaults {
                    outer: other.clone(),
                    inner: path.clone(),
                });
            }
        }
    }
    let taken = |path: &str| {
        existing
            .iter()
            .any(|there| fold(there.as_ref()) == fold(path))
    };
    for there in existing {
        let there = there.as_ref();
        if there == VAULT_MANIFEST || there.ends_with(&format!("/{VAULT_MANIFEST}")) {
            return Err(AdoptError::VaultExists(
                there
                    .strip_suffix(&format!("/{VAULT_MANIFEST}"))
                    .unwrap_or(there)
                    .to_string(),
            ));
        }
    }

    let mut files: Vec<SetupFile> = Vec::new();
    let mut vaults: Vec<PlannedVault> = Vec::new();
    let mut entries: Vec<(String, String)> = Vec::new();

    for (index, (vault, path)) in adoption.vaults.iter().zip(&paths).enumerate() {
        if taken(path) {
            return Err(AdoptError::NotADirectory(path.clone()));
        }
        let id = vault_ids[index].clone();
        let label = path.rsplit('/').next().unwrap_or(path);
        let naming = if vault.encrypted && adoption.kind == AdoptKind::Journal {
            "id"
        } else {
            "plain"
        };
        for file in vault_files(label, &id, created_at, vault.encrypted, naming, &[]) {
            let at = format!("{path}/{}", file.path);
            if taken(&at) {
                return Err(AdoptError::FileTaken(at));
            }
            files.push(SetupFile {
                path: at,
                contents: file.contents,
                change: FileChange::Create,
            });
        }
        let prefix = format!("{}/", fold(path));
        let holds_files = existing
            .iter()
            .any(|there| fold(there.as_ref()).starts_with(&prefix));
        vaults.push(PlannedVault {
            path: path.clone(),
            id: id.clone(),
            encrypted: vault.encrypted,
            holds_files,
        });
        entries.push((path.clone(), id));
    }

    // `fjord.json`, first in the list: a vault the manifest does not list is only a warning (W601), where a
    // manifest listing a vault that was never made is an error (E106).
    let mut manifest = serde_json::Map::new();
    manifest.insert(field::FJORD.into(), json!(FORMAT_VERSION));
    manifest.insert(field::ID.into(), json!(repository_id));
    manifest.insert(field::NAME.into(), json!(adoption.repository_name));
    manifest.insert(field::CREATED_AT.into(), json!(created_at));
    manifest.insert(field::GENERATOR.into(), json!(adoption.generator));
    match adoption.kind {
        AdoptKind::Drive => {}
        AdoptKind::Journal => {
            manifest.insert(field::KIND.into(), json!(Kind::JOURNAL));
        }
        AdoptKind::Ssg(engine) => {
            manifest.insert(field::KIND.into(), json!(Kind::SSG));
            manifest.insert(Kind::SSG.into(), json!({ field::ENGINE: engine.as_str() }));
        }
    }
    manifest.insert(
        field::VAULTS.into(),
        entries
            .iter()
            .map(|(path, id)| json!({ field::PATH: path, field::ID: id }))
            .collect(),
    );
    files.insert(
        0,
        SetupFile {
            path: REPOSITORY_MANIFEST.to_string(),
            contents: pretty(&serde_json::Value::Object(manifest)),
            change: FileChange::Create,
        },
    );

    // Spec §9, in every repository: the vault that is added next may be encrypted.
    match (roots.contains(&".gitattributes"), gitattributes) {
        (false, _) => files.push(SetupFile {
            path: ".gitattributes".to_string(),
            contents: SETUP_GITATTRIBUTES.to_string(),
            change: FileChange::Create,
        }),
        (true, None) => return Err(AdoptError::GitattributesNotRead),
        (true, Some(text)) if crate::scaffold::has_merge_guard(text) => {}
        (true, Some(text)) => files.push(SetupFile {
            path: ".gitattributes".to_string(),
            contents: appended(text, SETUP_GITATTRIBUTES),
            change: FileChange::Append,
        }),
    }

    // A checkout's record is local state and must never be committed (spec §2.2, §6.6): where something is
    // encrypted, the root `.gitignore` says so. Only then, and only by adding to it.
    if vaults.iter().any(|vault| vault.encrypted) {
        match (roots.contains(&".gitignore"), gitignore) {
            (false, _) => files.push(SetupFile {
                path: ".gitignore".to_string(),
                contents: GITIGNORE.to_string(),
                change: FileChange::Create,
            }),
            (true, None) => return Err(AdoptError::GitignoreNotRead),
            (true, Some(text)) if ignores_local_state(text) => {}
            (true, Some(text)) => files.push(SetupFile {
                path: ".gitignore".to_string(),
                contents: appended(text, LOCAL_STATE_IGNORE),
                change: FileChange::Append,
            }),
        }
    }

    Ok(AdoptPlan {
        files,
        repository_id: repository_id.to_string(),
        vaults,
        created_at: created_at.to_string(),
    })
}

/// The lines a root `.gitignore` gains where it has no `.fjord/local/`.
const LOCAL_STATE_IGNORE: &str = "# Fjord: local state (a checkout's record) and keys. Never committed (spec §2.2, §11.3).\n.fjord/local/\nidentity.txt\nidentity*.txt\n*.identity\n*.agekey\nage-key*.txt\n";

fn ignores_local_state(text: &str) -> bool {
    text.lines().map(str::trim).any(|line| {
        matches!(
            line,
            ".fjord/local/" | ".fjord/local" | "/.fjord/local/" | ".fjord/" | "/.fjord/" | ".fjord"
        )
    })
}

/// `text` with `addition` after it, on a line of its own, and nothing of `text` changed.
fn appended(text: &str, addition: &str) -> String {
    let mut contents = text.to_string();
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(addition);
    contents
}

/// A vault path as a path: relative, `/`-separated, each part a name §5 allows and none hidden.
fn check_vault_path(path: &str) -> Result<String, AdoptError> {
    let invalid = |reason: &str| AdoptError::InvalidVaultPath {
        path: path.to_string(),
        reason: reason.to_string(),
    };
    let path = to_nfc(path.trim_end_matches('/'));
    if path.is_empty() {
        return Err(invalid(
            "it is empty (the repository's root cannot be a vault)",
        ));
    }
    if path.starts_with('/') || path.contains('\\') {
        return Err(invalid(
            "it must be relative to the repository, with `/` between names",
        ));
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(invalid("it has an empty, `.` or `..` part"));
        }
        if part.starts_with('.') {
            return Err(invalid("it would be, or be inside, a hidden directory"));
        }
        if let Some(code) = check_component(part).first() {
            return Err(invalid(&format!("{part:?}: {code}")));
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;

    const WHEN: &str = "2026-11-03T00:55:00Z";

    fn ids(count: usize) -> Vec<String> {
        (0..count)
            .map(|n| format!("01jagc4k7pr9tbm3ykwx6zq2h{n}"))
            .collect()
    }

    fn adopt(kind: AdoptKind, vaults: &[(&str, bool)]) -> Adoption {
        Adoption {
            repository_name: "Mine".to_string(),
            generator: "test".to_string(),
            kind,
            vaults: vaults
                .iter()
                .map(|(path, encrypted)| AdoptedVault {
                    path: (*path).to_string(),
                    encrypted: *encrypted,
                })
                .collect(),
        }
    }

    fn plan(
        adoption: &Adoption,
        existing: &[&str],
        gitattributes: Option<&str>,
        gitignore: Option<&str>,
    ) -> Result<AdoptPlan, AdoptError> {
        plan_adopt(
            adoption,
            "01jagc4k7pqw2xn8rvty5zb3md",
            WHEN,
            &ids(adoption.vaults.len()),
            existing,
            gitattributes,
            gitignore,
        )
    }

    #[test]
    fn a_drive_adopts_the_directories_it_is_given_and_writes_over_nothing() {
        let existing = ["README.md", "notes/a.md", "notes/b/c.md", "docs/x.md"];
        let made = plan(
            &adopt(AdoptKind::Drive, &[("notes", false), ("docs", false)]),
            &existing,
            None,
            None,
        )
        .expect("a plan");
        let paths: Vec<&str> = made.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "fjord.json",
                "notes/fjord.vault.json",
                "docs/fjord.vault.json",
                ".gitattributes"
            ]
        );
        // Every file is new, and none is one that is there.
        assert!(made.files.iter().all(|f| f.change == FileChange::Create));
        assert!(made
            .files
            .iter()
            .all(|f| !existing.contains(&f.path.as_str())));

        let manifest = Manifest::parse(made.files[0].contents.as_bytes()).expect("parses");
        assert!(
            manifest.raw().get("kind").is_none(),
            "a drive writes no kind"
        );
        assert_eq!(
            made.vaults,
            [
                PlannedVault {
                    path: "notes".into(),
                    id: ids(2)[0].clone(),
                    encrypted: false,
                    holds_files: true
                },
                PlannedVault {
                    path: "docs".into(),
                    id: ids(2)[1].clone(),
                    encrypted: false,
                    holds_files: true
                },
            ]
        );
    }

    #[test]
    fn a_vault_may_be_below_the_root_and_a_new_one_holds_no_files() {
        let made = plan(
            &adopt(AdoptKind::Drive, &[("src/content", false)]),
            &["package.json"],
            None,
            None,
        )
        .expect("a plan");
        assert_eq!(made.vaults[0].path, "src/content");
        assert!(!made.vaults[0].holds_files, "nothing is in it yet");
        assert!(made
            .files
            .iter()
            .any(|f| f.path == "src/content/fjord.vault.json"));
        // The label is the last name.
        let vault = made
            .files
            .iter()
            .find(|f| f.path == "src/content/fjord.vault.json")
            .expect("manifest");
        assert!(vault.contents.contains("\"name\": \"content\""));
    }

    #[test]
    fn a_site_is_one_plaintext_vault_with_the_engine_recorded() {
        let made = plan(
            &adopt(AdoptKind::Ssg(SiteEngine::Astro), &[("src/content", false)]),
            &["astro.config.mjs", "src/content/posts/a.md"],
            None,
            None,
        )
        .expect("a plan");
        let manifest = Manifest::parse(made.files[0].contents.as_bytes()).expect("parses");
        assert_eq!(manifest.raw()["kind"], "ssg");
        assert_eq!(manifest.raw()["ssg"]["engine"], "astro");
        assert!(plan(
            &adopt(AdoptKind::Ssg(SiteEngine::Astro), &[("src/content", true)]),
            &[],
            None,
            None
        )
        .is_err_and(|e| e == AdoptError::EncryptedSite));
    }

    #[test]
    fn an_encrypted_journal_is_named_by_id_and_says_it_holds_files() {
        let made = plan(
            &adopt(AdoptKind::Journal, &[("journal", true)]),
            &["journal/2026-11-02.md"],
            None,
            None,
        )
        .expect("a plan");
        assert!(made.vaults[0].holds_files);
        let manifest = made
            .files
            .iter()
            .find(|f| f.path == "journal/fjord.vault.json")
            .expect("manifest");
        assert!(manifest.contents.contains("\"fileNaming\": \"id\""));
        assert!(manifest.contents.contains("\"container\": \"tar\""));
        let paths: Vec<&str> = made.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"journal/recipients.txt"));
        assert!(paths.contains(&"journal/.gitignore"));
        // A checkout's record is local state: the root .gitignore is made to say so.
        let ignore = made
            .files
            .iter()
            .find(|f| f.path == ".gitignore")
            .expect(".gitignore");
        assert!(ignore.contents.contains(".fjord/local/"));
    }

    #[test]
    fn gitattributes_and_gitignore_only_gain_lines() {
        let attributes = "*.png binary";
        let ignore = "target/\nnode_modules/";
        let made = plan(
            &adopt(AdoptKind::Journal, &[("journal", true)]),
            &[".gitattributes", ".gitignore", "journal/a.md"],
            Some(attributes),
            Some(ignore),
        )
        .expect("a plan");
        for (path, original) in [(".gitattributes", attributes), (".gitignore", ignore)] {
            let file = made.files.iter().find(|f| f.path == path).expect(path);
            assert_eq!(file.change, FileChange::Append, "{path}");
            assert!(
                file.contents.starts_with(original),
                "{path}: nothing is reworded"
            );
            assert!(file.contents[original.len()..].starts_with('\n'), "{path}");
        }
        // Already there: left alone.
        let made = plan(
            &adopt(AdoptKind::Journal, &[("journal", true)]),
            &[".gitattributes", ".gitignore"],
            Some("*.age binary -diff -merge\n"),
            Some(".fjord/local/\n"),
        )
        .expect("a plan");
        assert!(made
            .files
            .iter()
            .all(|f| f.path != ".gitattributes" && f.path != ".gitignore"));
    }

    #[test]
    fn a_plaintext_adoption_leaves_the_gitignore_alone() {
        let made = plan(
            &adopt(AdoptKind::Drive, &[("notes", false)]),
            &[".gitignore", "notes/a.md"],
            None,
            Some("target/"),
        )
        .expect("a plan");
        assert!(made.files.iter().all(|f| f.path != ".gitignore"));
    }

    #[test]
    fn what_is_there_is_never_written_over() {
        let drive = |existing: &[&str]| {
            plan(
                &adopt(AdoptKind::Drive, &[("notes", true)]),
                existing,
                None,
                None,
            )
        };
        assert_eq!(drive(&["fjord.json"]), Err(AdoptError::AlreadyFjord));
        assert_eq!(
            drive(&["notes/.gitignore"]),
            Err(AdoptError::FileTaken("notes/.gitignore".into()))
        );
        assert_eq!(
            drive(&["notes/recipients.txt"]),
            Err(AdoptError::FileTaken("notes/recipients.txt".into()))
        );
        assert_eq!(
            drive(&["old/fjord.vault.json"]),
            Err(AdoptError::VaultExists("old".into()))
        );
        assert_eq!(
            drive(&["notes"]),
            Err(AdoptError::NotADirectory("notes".into()))
        );
        assert_eq!(
            plan(
                &adopt(AdoptKind::Drive, &[("notes", false)]),
                &[".gitattributes"],
                None,
                None
            ),
            Err(AdoptError::GitattributesNotRead)
        );
    }

    #[test]
    fn the_kinds_rules_and_the_paths_are_checked() {
        let none: [&str; 0] = [];
        let check = |kind, vaults: &[(&str, bool)]| plan(&adopt(kind, vaults), &none, None, None);
        assert!(matches!(
            check(AdoptKind::Drive, &[]),
            Err(AdoptError::VaultCount { .. })
        ));
        assert!(matches!(
            check(AdoptKind::Journal, &[("a", false), ("b", false)]),
            Err(AdoptError::VaultCount { .. })
        ));
        assert_eq!(
            check(AdoptKind::Drive, &[("a", false), ("a/b", false)]),
            Err(AdoptError::NestedVaults {
                outer: "a".into(),
                inner: "a/b".into()
            })
        );
        assert_eq!(
            check(AdoptKind::Drive, &[("a/b", false), ("a", false)]),
            Err(AdoptError::NestedVaults {
                outer: "a".into(),
                inner: "a/b".into()
            })
        );
        assert_eq!(
            check(AdoptKind::Drive, &[("Notes", false), ("notes", false)]),
            Err(AdoptError::DuplicateVault("notes".into()))
        );
        for bad in [
            "", "/abs", "a/../b", "../a", ".hidden", "a/.git", "a\\b", "a//b", "CON", "a?",
        ] {
            assert!(
                matches!(
                    check(AdoptKind::Drive, &[(bad, false)]),
                    Err(AdoptError::InvalidVaultPath { .. })
                ),
                "{bad:?} should be refused"
            );
        }
        // A trailing slash is the same directory.
        assert!(check(AdoptKind::Drive, &[("notes/", false)]).is_ok());
    }

    #[test]
    fn a_site_is_known_by_its_engines_files() {
        assert_eq!(
            detect_site(&["astro.config.mjs", "package.json", "src/content/a.md"]),
            Some(DetectedSite {
                engine: SiteEngine::Astro,
                content: "src/content"
            })
        );
        assert_eq!(
            detect_site(&["astro.config.ts"]).map(|s| s.engine),
            Some(SiteEngine::Astro)
        );
        assert_eq!(
            detect_site(&["_config.yml", "_posts/2026-01-01-a.md"]),
            Some(DetectedSite {
                engine: SiteEngine::Jekyll,
                content: "_posts"
            })
        );
        // Only at the root: a nested project is not this repository's site.
        assert_eq!(
            detect_site(&["docs/astro.config.mjs", "notes/_config.yml"]),
            None
        );
        assert_eq!(detect_site(&["README.md"]), None);
    }
}

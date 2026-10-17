// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The contents of a new repository. Spec §2, §3, §4.
//!
//! Split in two on purpose. [`plan`] decides what a new repository contains
//! and returns it as text, touching no filesystem; [`write`] is the only
//! function here that performs IO. A client with a virtual filesystem — the
//! web build — reuses `plan` and supplies its own writer.
//!
//! # What a fresh repository is, and is not
//!
//! `Private` is created **encrypted with no recipients**. Spec §6.2 makes
//! that valid and explicitly unwritable, and it is the honest state of a
//! repository whose owner has not yet produced a key: the alternative is to
//! invent one, or to leave the vault in the clear while calling it private.
//! `fjord verify` reports [`Code::NoRecipients`][c] on a fresh repository
//! for exactly this reason, and that is a warning, not a fault.
//!
//! [c]: crate::diagnostics::Code::NoRecipients

use crate::manifest::{field, CONVENTIONAL_RECIPIENTS_FILE, SUFFIX_AGE, TOOL_AGE};
use crate::{FORMAT_VERSION, REPOSITORY_MANIFEST, VAULT_MANIFEST};
use serde_json::json;
use std::fs;
use std::io::Write as _;
use std::path::Path;

/// The plaintext vault a new repository starts with.
pub const PUBLIC_VAULT: &str = "Public";

/// The encrypted vault a new repository starts with.
pub const PRIVATE_VAULT: &str = "Private";

/// Files whose content never varies. These are the same bytes the
/// conforming fixture carries, and a test holds the two together: what
/// `init` writes is what the fixture says a conforming repository looks
/// like.
const README: &str = include_str!("../templates/README.md");
const GITATTRIBUTES: &str = include_str!("../templates/gitattributes");
const GITIGNORE: &str = include_str!("../templates/gitignore");
const VAULT_GITIGNORE: &str = include_str!("../templates/vault.gitignore");
const RECIPIENTS: &str = include_str!("../templates/recipients.txt");
const WELCOME: &str = include_str!("../templates/welcome.md");

/// What to create.
#[derive(Debug, Clone)]
pub struct Settings {
    /// The repository's display label. Spec §3.
    pub name: String,
    /// Whether `Private` is encrypted. When false it is an ordinary
    /// plaintext vault, and no recipients file or guard is written.
    pub encrypt_private: bool,
    /// Tool and version, recorded in `generator`: `"fjord 0.1.0"`. Spec §3.
    ///
    /// Required here even though the spec makes the field optional, so that
    /// every client that creates a repository has to name itself — the
    /// desktop and mobile apps will pass their own. It is the caller's to
    /// supply because only the caller knows what it is: this crate cannot
    /// tell a CLI from an app, and its own version is not theirs.
    pub generator: String,
}

/// One file to create, with its contents.
#[derive(Debug, Clone)]
pub struct PlannedFile {
    /// Repository-relative, with forward slashes.
    pub path: String,
    pub contents: String,
}

/// Everything a new repository contains.
#[derive(Debug, Clone)]
pub struct Plan {
    pub files: Vec<PlannedFile>,
    pub repository_id: String,
    /// `(directory, id)` for each vault, in creation order.
    pub vaults: Vec<(String, String)>,
    /// The timestamp written into every manifest and the starter document,
    /// so one repository has one creation time.
    pub created_at: String,
}

impl Plan {
    /// The paths this plan would create, for a caller that wants to show
    /// them before writing.
    pub fn paths(&self) -> Vec<&str> {
        self.files.iter().map(|file| file.path.as_str()).collect()
    }
}

/// Why a repository could not be written.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    /// Refusing to overwrite. `write` never replaces an existing file:
    /// scaffolding over someone's work is not a recoverable mistake.
    #[error("{0} already exists")]
    Exists(String),
}

/// Decide what a new repository contains. Performs no IO.
///
/// Reads the clock and generates identifiers, so two calls differ.
pub fn plan(settings: &Settings) -> Plan {
    let created_at = crate::scalar::now_rfc3339_utc();
    let repository_id = crate::scalar::new_ulid();
    let public_id = crate::scalar::new_ulid();
    let private_id = crate::scalar::new_ulid();
    let welcome_id = crate::scalar::new_ulid();

    let mut files = Vec::new();

    files.push(PlannedFile {
        path: REPOSITORY_MANIFEST.to_string(),
        contents: repository_manifest(
            settings,
            &repository_id,
            &created_at,
            &[(PUBLIC_VAULT, &public_id), (PRIVATE_VAULT, &private_id)],
        ),
    });

    files.push(PlannedFile {
        path: ".gitattributes".to_string(),
        contents: GITATTRIBUTES.to_string(),
    });
    files.push(PlannedFile {
        path: ".gitignore".to_string(),
        contents: GITIGNORE.to_string(),
    });
    files.push(PlannedFile {
        path: "README.md".to_string(),
        contents: README.to_string(),
    });

    // Public: plaintext, with one starter document so the repository is not
    // empty on first open.
    files.push(PlannedFile {
        path: format!("{PUBLIC_VAULT}/{VAULT_MANIFEST}"),
        contents: vault_manifest(PUBLIC_VAULT, &public_id, &created_at, false),
    });
    files.push(PlannedFile {
        path: format!("{PUBLIC_VAULT}/welcome.md"),
        contents: WELCOME
            .replace("{{id}}", &welcome_id)
            .replace("{{created}}", &created_at),
    });

    // Private.
    files.push(PlannedFile {
        path: format!("{PRIVATE_VAULT}/{VAULT_MANIFEST}"),
        contents: vault_manifest(
            PRIVATE_VAULT,
            &private_id,
            &created_at,
            settings.encrypt_private,
        ),
    });
    if settings.encrypt_private {
        files.push(PlannedFile {
            path: format!("{PRIVATE_VAULT}/{CONVENTIONAL_RECIPIENTS_FILE}"),
            contents: RECIPIENTS.to_string(),
        });
        // The §6.5 plaintext guard. Without it, a decrypted working copy
        // left behind in the vault is one `git add` from being committed in
        // the clear.
        files.push(PlannedFile {
            path: format!("{PRIVATE_VAULT}/.gitignore"),
            contents: VAULT_GITIGNORE.to_string(),
        });
    }

    Plan {
        files,
        repository_id,
        vaults: vec![
            (PUBLIC_VAULT.to_string(), public_id),
            (PRIVATE_VAULT.to_string(), private_id),
        ],
        created_at,
    }
}

/// The files a new vault consists of. Spec §2.3, §4.
///
/// Paths are relative to the vault's own directory, so the caller decides
/// where it goes.
pub fn vault_files(
    name: &str,
    id: &str,
    created_at: &str,
    encrypted: bool,
    file_naming: &str,
) -> Vec<PlannedFile> {
    let mut files = vec![PlannedFile {
        path: VAULT_MANIFEST.to_string(),
        contents: vault_manifest_with(name, id, created_at, encrypted, file_naming),
    }];
    if encrypted {
        files.push(PlannedFile {
            path: CONVENTIONAL_RECIPIENTS_FILE.to_string(),
            contents: RECIPIENTS.to_string(),
        });
        files.push(PlannedFile {
            path: ".gitignore".to_string(),
            contents: VAULT_GITIGNORE.to_string(),
        });
    }
    files
}

/// Add a vault to `fjord.json`, returning the rewritten manifest.
///
/// Every other field survives, in its original order — invariant 3 and
/// §10.1 — which is the whole reason manifests are held as parsed maps
/// rather than typed structs. A `generator` this build does not understand,
/// or a field a newer client added, is still there afterwards.
pub fn with_vault_entry(
    manifest: &crate::manifest::Manifest,
    path: &str,
    id: &str,
) -> Result<String, Error> {
    let mut raw = manifest.raw().clone();
    let mut vaults = match raw.get(field::VAULTS) {
        Some(serde_json::Value::Array(existing)) => existing.clone(),
        _ => Vec::new(),
    };
    vaults.push(json!({ field::PATH: path, field::ID: id }));
    raw.insert(field::VAULTS.to_string(), serde_json::Value::Array(vaults));

    Ok(pretty(&serde_json::Value::Object(raw)))
}

/// Write a plan to disk, creating `root` and any parent directories.
///
/// Never overwrites: an existing file is [`Error::Exists`], and the caller
/// decides what to tell the user.
pub fn write(root: &Path, plan: &Plan) -> Result<(), Error> {
    create_dir_all(root)?;

    for file in &plan.files {
        let path = root.join(&file.path);
        if let Some(parent) = path.parent() {
            create_dir_all(parent)?;
        }

        // `create_new` is the whole guarantee: it fails rather than
        // truncating, with no window between the check and the write.
        let mut handle = match fs::File::create_new(&path) {
            Ok(handle) => handle,
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Error::Exists(file.path.clone()))
            }
            Err(source) => {
                return Err(Error::Io {
                    path: file.path.clone(),
                    source,
                })
            }
        };
        if let Err(source) = handle.write_all(file.contents.as_bytes()) {
            return Err(Error::Io {
                path: file.path.clone(),
                source,
            });
        }
    }

    Ok(())
}

fn create_dir_all(path: &Path) -> Result<(), Error> {
    fs::create_dir_all(path).map_err(|source| Error::Io {
        path: path.display().to_string(),
        source,
    })
}

fn repository_manifest(
    settings: &Settings,
    id: &str,
    created_at: &str,
    vaults: &[(&str, &str)],
) -> String {
    let vaults: Vec<serde_json::Value> = vaults
        .iter()
        .map(|(path, id)| json!({ field::PATH: path, field::ID: id }))
        .collect();

    pretty(&json!({
        field::FJORD: FORMAT_VERSION,
        field::ID: id,
        field::NAME: settings.name,
        field::CREATED_AT: created_at,
        field::GENERATOR: settings.generator,
        field::VAULTS: vaults,
    }))
}

fn vault_manifest(name: &str, id: &str, created_at: &str, encrypted: bool) -> String {
    vault_manifest_with(name, id, created_at, encrypted, "plain")
}

fn vault_manifest_with(
    name: &str,
    id: &str,
    created_at: &str,
    encrypted: bool,
    file_naming: &str,
) -> String {
    let encryption = if encrypted {
        json!({
            field::TOOL: TOOL_AGE,
            field::RECIPIENTS: CONVENTIONAL_RECIPIENTS_FILE,
            field::SUFFIX: SUFFIX_AGE,
            // §7.2 requires the tar container whenever the name is an id,
            // because the real name then has nowhere else to live.
            field::CONTAINER: if file_naming == "id" { "tar" } else { "none" },
            // Binary: ciphertext is unreadable either way, so armor costs
            // size and buys nothing. Spec §4.1 recommends false.
            field::ARMOR: false,
        })
    } else {
        serde_json::Value::Null
    };

    pretty(&json!({
        field::FJORD: FORMAT_VERSION,
        field::ID: id,
        field::NAME: name,
        field::CREATED_AT: created_at,
        field::ENCRYPTION: encryption,
        field::FILE_NAMING: file_naming,
    }))
}

/// Two-space indented JSON with a trailing newline: a manifest is a file a
/// person reads and edits, not a wire format.
fn pretty(value: &serde_json::Value) -> String {
    match serde_json::to_string_pretty(value) {
        Ok(text) => format!("{text}\n"),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use crate::scalar;

    fn settings(encrypt: bool) -> Settings {
        Settings {
            name: "Notes".to_string(),
            encrypt_private: encrypt,
            generator: "fjord test".to_string(),
        }
    }

    #[test]
    fn an_encrypted_repository_has_every_file_the_spec_requires() {
        let plan = plan(&settings(true));
        let mut paths = plan.paths();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                ".gitattributes",
                ".gitignore",
                "Private/.gitignore",
                "Private/fjord.vault.json",
                "Private/recipients.txt",
                "Public/fjord.vault.json",
                "Public/welcome.md",
                "README.md",
                "fjord.json",
            ]
        );
    }

    fn repository_manifest_text(plan: &Plan) -> String {
        match plan
            .files
            .iter()
            .find(|file| file.path == REPOSITORY_MANIFEST)
        {
            Some(file) => file.contents.clone(),
            None => panic!("no fjord.json in the plan"),
        }
    }

    #[test]
    fn the_generator_is_whatever_the_caller_says_it_is() {
        // This crate cannot tell a CLI from an app, so the caller names
        // itself; the desktop client will pass something else entirely.
        let mut named = settings(true);
        named.generator = "fjord-desktop 2.4.1".to_string();
        let manifest = repository_manifest_text(&plan(&named));

        let parsed = Manifest::parse(manifest.as_bytes()).expect("parse");
        assert_eq!(parsed.string(field::GENERATOR), Some("fjord-desktop 2.4.1"));
    }

    #[test]
    fn the_generator_sits_where_the_specs_example_puts_it() {
        // After createdAt and before the vaults, which is also where a
        // person reading the file expects to find it.
        let manifest = repository_manifest_text(&plan(&settings(true)));
        let created = manifest.find("createdAt").expect("createdAt");
        let generator = manifest.find("generator").expect("generator");
        let vaults = manifest.find("\"vaults\"").expect("vaults");
        assert!(created < generator && generator < vaults, "{manifest}");
    }

    #[test]
    fn a_plaintext_private_vault_has_no_recipients_or_guard() {
        let plan = plan(&settings(false));
        let paths = plan.paths();
        assert!(!paths.contains(&"Private/recipients.txt"));
        assert!(!paths.contains(&"Private/.gitignore"));
    }

    #[test]
    fn identifiers_are_ulids_and_all_distinct() {
        let plan = plan(&settings(true));
        assert!(scalar::is_ulid(&plan.repository_id));
        let mut ids = vec![plan.repository_id.clone()];
        for (_, id) in &plan.vaults {
            assert!(scalar::is_ulid(id), "{id} is not a ULID");
            ids.push(id.clone());
        }
        ids.sort();
        ids.dedup();
        assert_eq!(
            ids.len(),
            3,
            "a repository and its vaults must not share ids"
        );
    }

    #[test]
    fn the_timestamp_is_rfc3339_utc_and_shared() {
        let plan = plan(&settings(true));
        assert!(scalar::is_rfc3339_utc(&plan.created_at));
        // Whole seconds, so no fractional part.
        assert!(!plan.created_at.contains('.'), "{}", plan.created_at);

        for file in &plan.files {
            if file.path.ends_with(".json") {
                assert!(
                    file.contents.contains(&plan.created_at),
                    "{} does not carry the repository's creation time",
                    file.path
                );
            }
        }
    }

    #[test]
    fn the_vault_id_matches_its_entry_in_fjord_json() {
        let plan = plan(&settings(true));
        let repository = plan
            .files
            .iter()
            .find(|file| file.path == REPOSITORY_MANIFEST)
            .expect("fjord.json");
        for (directory, id) in &plan.vaults {
            let vault = plan
                .files
                .iter()
                .find(|file| file.path == format!("{directory}/{VAULT_MANIFEST}"))
                .expect("vault manifest");
            assert!(vault.contents.contains(id));
            assert!(repository.contents.contains(id));
        }
    }

    #[test]
    fn manifests_parse_and_carry_the_required_fields() {
        let plan = plan(&settings(true));
        for file in &plan.files {
            if !file.path.ends_with(".json") {
                continue;
            }
            let manifest = match Manifest::parse(file.contents.as_bytes()) {
                Ok(manifest) => manifest,
                Err(err) => panic!("{} did not parse: {err}", file.path),
            };
            assert_eq!(manifest.version(), Some(i64::from(FORMAT_VERSION)));
            assert!(manifest.has(field::ID));
            assert!(manifest.has(field::NAME));
            assert!(manifest.has(field::CREATED_AT));
        }
    }

    #[test]
    fn the_private_guard_is_the_one_the_spec_prints() {
        let plan = plan(&settings(true));
        let guard = plan
            .files
            .iter()
            .find(|file| file.path == "Private/.gitignore")
            .expect("plaintext guard");
        // §6.5: ignore everything, re-permit payloads and machinery.
        for rule in ["*", "!*/", "!*.age", "!fjord.vault.json", "!recipients.txt"] {
            assert!(
                guard.contents.lines().any(|line| line.trim() == rule),
                "the guard is missing `{rule}`"
            );
        }
    }

    #[test]
    fn a_fresh_recipients_file_has_no_keys() {
        // Deliberate: §6.2 makes a vault with no recipients valid and
        // unwritable, and inventing a key would be worse.
        let plan = plan(&settings(true));
        let recipients = plan
            .files
            .iter()
            .find(|file| file.path == "Private/recipients.txt")
            .expect("recipients file");
        assert!(
            crate::manifest::parse_recipients(&recipients.contents).is_empty(),
            "a fresh recipients file must contain only comments"
        );
        // But it must tell the user how to add one.
        assert!(recipients.contents.contains("age-keygen"));
    }

    #[test]
    fn the_starter_document_is_a_doc() {
        let plan = plan(&settings(true));
        let welcome = plan
            .files
            .iter()
            .find(|file| file.path == "Public/welcome.md")
            .expect("welcome.md");
        let frontmatter = match crate::doc::parse(&welcome.contents) {
            crate::doc::Parse::Present { frontmatter, .. } => frontmatter,
            other => panic!("welcome.md has no frontmatter: {other:?}"),
        };
        assert!(
            frontmatter.doc_id().is_some(),
            "no valid id was substituted"
        );
        assert_eq!(frontmatter.created(), Some(plan.created_at.as_str()));
        assert!(!welcome.contents.contains("{{"), "a placeholder survived");
    }

    #[test]
    fn write_refuses_to_overwrite() {
        let temp = match tempfile::tempdir() {
            Ok(temp) => temp,
            Err(err) => panic!("{err}"),
        };
        let plan = plan(&settings(true));
        assert!(write(temp.path(), &plan).is_ok());

        // Scaffolding over an existing repository is not a recoverable
        // mistake, so the second attempt must fail rather than truncate.
        match write(temp.path(), &plan) {
            Err(Error::Exists(path)) => assert_eq!(path, REPOSITORY_MANIFEST),
            other => panic!("expected Exists, got {other:?}"),
        }
    }
}

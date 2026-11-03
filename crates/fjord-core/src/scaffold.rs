// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The contents of a new repository, and of the vault added to an existing one. Spec §2, §3, §4.
//!
//! Three layers, so a client with no filesystem and no clock (the web build) can use all but the last:
//!
//! - [`plan_with`] decides what a new repository contains and returns it as text. It is pure: the
//!   time and the identifiers are the caller's ([`Origin`]), and so is writing the files.
//! - [`plan_setup`] decides what to add to a repository that is **not** a Fjord repository yet: a
//!   `fjord.json` and one plaintext vault, nothing else, and it never touches a file that is there
//!   except to append the one line spec §9 requires to `.gitattributes`.
//! - [`plan`] and [`write()`] are the native conveniences: [`plan`] reads the clock and makes the
//!   identifiers, and [`write()`] is the only function here that performs IO.
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
use crate::path::{check_component, to_nfc};
use crate::{FORMAT_VERSION, REPOSITORY_MANIFEST, VAULT_MANIFEST};
use serde_json::json;
#[cfg(feature = "native")]
use std::fs;
#[cfg(feature = "native")]
use std::io::Write as _;
#[cfg(feature = "native")]
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
pub(crate) const GITIGNORE: &str = include_str!("../templates/gitignore");
const VAULT_GITIGNORE: &str = include_str!("../templates/vault.gitignore");
const RECIPIENTS: &str = include_str!("../templates/recipients.txt");
const WELCOME: &str = include_str!("../templates/welcome.md");
const SETUP_WELCOME: &str = include_str!("../templates/welcome-setup.md");
const JOURNAL_README: &str = include_str!("../templates/README-journal.md");
const SITE_README: &str = include_str!("../templates/README-ssg.md");
const SITE_WELCOME: &str = include_str!("../templates/ssg/welcome.md");
const ASTRO_GITIGNORE: &str = include_str!("../templates/gitignore-astro");
const JEKYLL_GITIGNORE: &str = include_str!("../templates/gitignore-jekyll");

/// The files an engine's site starts with, outside the vault. Spec §2, §3.1; Research 0001.
const ASTRO_FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../templates/ssg/astro/package.json"),
    ),
    (
        "astro.config.mjs",
        include_str!("../templates/ssg/astro/astro.config.mjs"),
    ),
    (
        "src/content.config.ts",
        include_str!("../templates/ssg/astro/src/content.config.ts"),
    ),
    (
        "src/layouts/Base.astro",
        include_str!("../templates/ssg/astro/src/layouts/Base.astro"),
    ),
    (
        "src/pages/index.astro",
        include_str!("../templates/ssg/astro/src/pages/index.astro"),
    ),
    (
        "src/pages/posts/[...slug].astro",
        include_str!("../templates/ssg/astro/src/pages/posts/[...slug].astro"),
    ),
];
const JEKYLL_FILES: &[(&str, &str)] = &[
    ("Gemfile", include_str!("../templates/ssg/jekyll/Gemfile")),
    (
        "_config.yml",
        include_str!("../templates/ssg/jekyll/_config.yml"),
    ),
    (
        "index.html",
        include_str!("../templates/ssg/jekyll/index.html"),
    ),
    (
        "_layouts/default.html",
        include_str!("../templates/ssg/jekyll/_layouts/default.html"),
    ),
    (
        "_layouts/post.html",
        include_str!("../templates/ssg/jekyll/_layouts/post.html"),
    ),
];

/// The directory of a new journal's one vault. The scaffold's choice, not the spec's: the vault may be
/// renamed and is still the journal's (§3.1).
pub const JOURNAL_VAULT: &str = "journal";

/// The directory of a new site's one vault, which the engine is configured to read.
pub const SITE_VAULT: &str = "content";

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

/// The time and the identifiers a plan is made with. The caller's, so that the pure part of this module
/// needs no clock and no random source: a client says what time it is and where its randomness comes from
/// (`Date.now()`, `crypto.getRandomValues`), and the same [`Origin`] always gives the same plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    /// RFC 3339 in UTC, written into every manifest and the starter document, so one repository has one
    /// creation time.
    pub created_at: String,
    pub repository_id: String,
    /// The plaintext vault (`Public` in [`plan_with`]; the one vault in [`plan_setup`]).
    pub vault_id: String,
    /// The starter document.
    pub welcome_id: String,
    /// The `Private` vault. Used by [`plan_with`] only; [`plan_setup`] makes one vault and ignores it.
    pub private_vault_id: String,
}

impl Origin {
    /// How many random bytes [`Origin::from_entropy`] needs: ten for each of four identifiers would do;
    /// sixteen each keeps the arithmetic obvious.
    pub const ENTROPY_BYTES: usize = 5 * 16;

    /// An origin from the time (milliseconds since the Unix epoch) and at least [`Self::ENTROPY_BYTES`]
    /// random bytes, or `None` if the time cannot be written as a date or there are too few bytes. Each
    /// identifier takes its own 16 bytes, so no two share any of their randomness.
    pub fn from_entropy(timestamp_ms: u64, random: &[u8]) -> Option<Origin> {
        if random.len() < Self::ENTROPY_BYTES {
            return None;
        }
        let id = |index: usize| {
            let mut bytes = [0u8; 16];
            bytes.copy_from_slice(&random[index * 16..index * 16 + 16]);
            crate::scalar::new_ulid_from(timestamp_ms, bytes)
        };
        Some(Origin {
            created_at: crate::scalar::rfc3339_utc_from_unix(
                i64::try_from(timestamp_ms / 1000).ok()?,
            )?,
            repository_id: id(0),
            vault_id: id(1),
            welcome_id: id(2),
            private_vault_id: id(3),
        })
    }
}

/// Decide what a new repository contains, with the clock and the identifiers of this moment. Performs no
/// IO. Two calls differ. See [`plan_with`] for the pure form.
#[cfg(feature = "native")]
pub fn plan(settings: &Settings) -> Plan {
    let origin = Origin {
        created_at: crate::scalar::now_rfc3339_utc(),
        repository_id: crate::scalar::new_ulid(),
        vault_id: crate::scalar::new_ulid(),
        welcome_id: crate::scalar::new_ulid(),
        private_vault_id: crate::scalar::new_ulid(),
    };
    plan_with(settings, &origin)
}

/// Decide what a new repository contains. Pure: the same settings and [`Origin`] give the same plan.
pub fn plan_with(settings: &Settings, origin: &Origin) -> Plan {
    let created_at = origin.created_at.clone();
    let repository_id = origin.repository_id.clone();
    let public_id = origin.vault_id.clone();
    let private_id = origin.private_vault_id.clone();
    let welcome_id = origin.welcome_id.clone();

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

// --- A repository of a kind (spec §3.1) -----------------------------------------------------------------

/// The engine a new `ssg` repository is built with. Only the engines this revision defines can be made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteEngine {
    Astro,
    Jekyll,
}

impl SiteEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            SiteEngine::Astro => crate::manifest::Engine::ASTRO,
            SiteEngine::Jekyll => crate::manifest::Engine::JEKYLL,
        }
    }

    /// The engine named `value`, if this build can make a site for it.
    pub fn parse(value: &str) -> Option<Self> {
        match crate::manifest::Engine::parse(value) {
            crate::manifest::Engine::Astro => Some(SiteEngine::Astro),
            crate::manifest::Engine::Jekyll => Some(SiteEngine::Jekyll),
            crate::manifest::Engine::Unknown(_) => None,
        }
    }
}

/// Which kind of repository to make, and the one choice each kind has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindChoice {
    /// Today's repository: `Public`, and `Private`, encrypted or not. No `kind` is written, so a drive
    /// made now is the same bytes as one made before kinds existed.
    Drive { encrypt_private: bool },
    /// One vault, `journal/`. Encrypted, it names its files by id inside a tar container, so that its
    /// entries can sit at the vault's root with no name or date showing (§7.2, §11.2).
    Journal { encrypted: bool },
    /// One plaintext vault, `content/`, and the engine's own files around it.
    Ssg { engine: SiteEngine },
}

/// What to create: [`Settings`] with a kind.
#[derive(Debug, Clone)]
pub struct KindSettings {
    /// The repository's display label. Spec §3.
    pub name: String,
    /// Tool and version, recorded in `generator`. Spec §3. See [`Settings::generator`].
    pub generator: String,
    pub kind: KindChoice,
}

/// Decide what a new repository of a kind contains, with the clock and the identifiers of this moment.
/// See [`plan_kind_with`] for the pure form.
#[cfg(feature = "native")]
pub fn plan_kind(settings: &KindSettings) -> Plan {
    let origin = Origin {
        created_at: crate::scalar::now_rfc3339_utc(),
        repository_id: crate::scalar::new_ulid(),
        vault_id: crate::scalar::new_ulid(),
        welcome_id: crate::scalar::new_ulid(),
        private_vault_id: crate::scalar::new_ulid(),
    };
    plan_kind_with(settings, &origin)
}

/// Decide what a new repository of a kind contains. Pure: the same settings and [`Origin`] give the same
/// plan. A drive is exactly [`plan_with`]'s.
pub fn plan_kind_with(settings: &KindSettings, origin: &Origin) -> Plan {
    match settings.kind {
        KindChoice::Drive { encrypt_private } => plan_with(
            &Settings {
                name: settings.name.clone(),
                encrypt_private,
                generator: settings.generator.clone(),
            },
            origin,
        ),
        KindChoice::Journal { encrypted } => plan_journal(settings, origin, encrypted),
        KindChoice::Ssg { engine } => plan_site(settings, origin, engine),
    }
}

fn kind_manifest(
    settings: &KindSettings,
    origin: &Origin,
    kind: &str,
    kind_settings: Option<serde_json::Value>,
    vault: &str,
) -> PlannedFile {
    // Built field by field, so the order is the spec's (§3, §3.1) whatever the map does.
    let mut manifest = serde_json::Map::new();
    manifest.insert(field::FJORD.into(), json!(FORMAT_VERSION));
    manifest.insert(field::ID.into(), json!(origin.repository_id));
    manifest.insert(field::NAME.into(), json!(settings.name));
    manifest.insert(field::CREATED_AT.into(), json!(origin.created_at));
    manifest.insert(field::GENERATOR.into(), json!(settings.generator));
    manifest.insert(field::KIND.into(), json!(kind));
    if let Some(kind_settings) = kind_settings {
        manifest.insert(kind.into(), kind_settings);
    }
    manifest.insert(
        field::VAULTS.into(),
        json!([{ field::PATH: vault, field::ID: origin.vault_id }]),
    );
    PlannedFile {
        path: REPOSITORY_MANIFEST.to_string(),
        contents: pretty(&serde_json::Value::Object(manifest)),
    }
}

fn file(path: impl Into<String>, contents: impl Into<String>) -> PlannedFile {
    PlannedFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn plan_journal(settings: &KindSettings, origin: &Origin, encrypted: bool) -> Plan {
    let mut files = vec![
        kind_manifest(
            settings,
            origin,
            crate::manifest::Kind::JOURNAL,
            None,
            JOURNAL_VAULT,
        ),
        file(".gitattributes", GITATTRIBUTES),
        file(".gitignore", GITIGNORE),
        file("README.md", JOURNAL_README),
        file(
            format!("{JOURNAL_VAULT}/{VAULT_MANIFEST}"),
            vault_manifest_with(
                "Journal",
                &origin.vault_id,
                &origin.created_at,
                encrypted,
                if encrypted { "id" } else { "plain" },
            ),
        ),
    ];
    // No starter entry: an entry's `date` is in the writer's local time, which only the client that
    // writes it knows, and an encrypted journal could not hold one in plaintext anyway.
    if encrypted {
        files.push(file(
            format!("{JOURNAL_VAULT}/{CONVENTIONAL_RECIPIENTS_FILE}"),
            RECIPIENTS,
        ));
        files.push(file(format!("{JOURNAL_VAULT}/.gitignore"), VAULT_GITIGNORE));
    }
    Plan {
        files,
        repository_id: origin.repository_id.clone(),
        vaults: vec![(JOURNAL_VAULT.to_string(), origin.vault_id.clone())],
        created_at: origin.created_at.clone(),
    }
}

fn plan_site(settings: &KindSettings, origin: &Origin, engine: SiteEngine) -> Plan {
    let (engine_files, engine_gitignore, posts, build) = match engine {
        SiteEngine::Astro => (
            ASTRO_FILES,
            ASTRO_GITIGNORE,
            "posts".to_string(),
            "Build it with Node.js: `npm install`, then `npm run build`; the site is written to `dist/`.",
        ),
        SiteEngine::Jekyll => (
            JEKYLL_FILES,
            JEKYLL_GITIGNORE,
            "_posts".to_string(),
            "Build it with Ruby: `bundle install`, then `bundle exec jekyll build`; the site is written to `_site/`.",
        ),
    };
    let label = match engine {
        SiteEngine::Astro => "Astro",
        SiteEngine::Jekyll => "Jekyll",
    };
    // Jekyll's rule, not a convention: a post's name is its date and title (Research 0001).
    let welcome = match engine {
        SiteEngine::Astro => "welcome.md".to_string(),
        SiteEngine::Jekyll => format!("{}-welcome.md", origin.created_at.get(..10).unwrap_or("")),
    };
    // The name goes into YAML as a JSON string, which YAML reads as a double-quoted scalar, so no name
    // can break the file.
    let quoted_name = serde_json::Value::String(settings.name.clone()).to_string();

    let mut files = vec![
        kind_manifest(
            settings,
            origin,
            crate::manifest::Kind::SSG,
            Some(json!({ field::ENGINE: engine.as_str() })),
            SITE_VAULT,
        ),
        file(".gitattributes", GITATTRIBUTES),
        file(".gitignore", format!("{GITIGNORE}{engine_gitignore}")),
        file(
            "README.md",
            SITE_README
                .replace("{{engine}}", label)
                .replace("{{build}}", build),
        ),
        file(
            format!("{SITE_VAULT}/{VAULT_MANIFEST}"),
            vault_manifest("Content", &origin.vault_id, &origin.created_at, false),
        ),
        file(
            format!("{SITE_VAULT}/{posts}/{welcome}"),
            SITE_WELCOME
                .replace("{{id}}", &origin.welcome_id)
                .replace("{{created}}", &origin.created_at),
        ),
    ];
    for (path, contents) in engine_files {
        files.push(file(*path, contents.replace("{{name}}", &quoted_name)));
    }
    Plan {
        files,
        repository_id: origin.repository_id.clone(),
        vaults: vec![(SITE_VAULT.to_string(), origin.vault_id.clone())],
        created_at: origin.created_at.clone(),
    }
}

// --- Adding Fjord to a repository that is not one -------------------------------------------------------

/// The line spec §9 requires of `.gitattributes`, so that Git never tries to diff or merge ciphertext.
/// A repository with only plaintext vaults has none, and `fjord verify` asks for it all the same
/// ([`Code::MergeGuardMissing`][c]): the vault that is added next may be encrypted.
///
/// [c]: crate::diagnostics::Code::MergeGuardMissing
pub const MERGE_GUARD: &str = "*.age binary -diff -merge";

/// Whether `.gitattributes` stops Git merging ciphertext. Spec §9.
///
/// Only `-merge` is required. `-diff` is strongly advisable and the specification's example sets it, but a
/// textual diff of ciphertext is merely useless, where a textual merge writes a corrupt file.
pub fn has_merge_guard(text: &str) -> bool {
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

/// The `.gitattributes` a repository needs once it holds an encrypted vault: `existing` (its text, or `None` for no such file) with
/// the §9 merge guard added at the end, or `None` when it already has the guard and nothing is to be written.
pub fn merge_guard_added(existing: Option<&str>) -> Option<String> {
    match existing {
        Some(text) if has_merge_guard(text) => None,
        Some(text) => {
            let mut next = text.to_string();
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str(MERGE_GUARD);
            next.push('\n');
            Some(next)
        }
        None => Some(format!("{MERGE_GUARD}\n")),
    }
}

/// What to add to a repository that is not a Fjord repository.
#[derive(Debug, Clone)]
pub struct Setup {
    /// The repository's display label, `fjord.json`'s `name`. Spec §3.
    pub repository_name: String,
    /// The vault's directory, at the root. It is also the vault's display name.
    pub vault: String,
    /// Tool and version, recorded in `generator`. Spec §3.
    pub generator: String,
}

/// How a file of a [`SetupPlan`] reaches the repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileChange {
    /// A file that is not there yet.
    Create,
    /// The repository's own `.gitattributes`, with the merge guard added at the end. The file's `contents`
    /// are the whole new file: everything that was there, then the guard. Nothing is removed or reworded.
    Append,
}

/// One file of a [`SetupPlan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupFile {
    /// Repository-relative, with forward slashes.
    pub path: String,
    /// The whole file as it is to be.
    pub contents: String,
    pub change: FileChange,
}

/// Everything [`plan_setup`] adds. **Additive**: every file is new except possibly `.gitattributes`, which
/// only ever gains a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupPlan {
    pub files: Vec<SetupFile>,
    pub repository_id: String,
    pub vault_id: String,
    pub created_at: String,
}

/// Why a repository cannot be set up, or not with this vault name.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SetupError {
    /// There is a `fjord.json`: this is a Fjord repository (a broken one is not ours to overwrite).
    #[error("this repository already has a fjord.json")]
    AlreadyFjord,
    /// The name cannot be a directory a vault lives in.
    #[error("\"{name}\" cannot be the name of a vault: {reason}")]
    InvalidVaultName { name: String, reason: String },
    /// Something at the root already has that name, case aside (spec §5 rule 6).
    #[error("\"{0}\" is already used in this repository")]
    VaultNameTaken(String),
    /// There is a `.gitattributes` but its text was not given, so the guard cannot be added to it.
    #[error(".gitattributes is there but its text was not supplied")]
    GitattributesNotRead,
}

impl SetupError {
    /// A stable name for the kind of failure, for a caller that reports it.
    pub fn code(&self) -> &'static str {
        match self {
            SetupError::AlreadyFjord => "already_fjord",
            SetupError::InvalidVaultName { .. } => "invalid_vault_name",
            SetupError::VaultNameTaken(_) => "vault_name_taken",
            SetupError::GitattributesNotRead => "gitattributes_not_read",
        }
    }
}

/// The names at the root of a repository, from the paths of everything in it.
pub(crate) fn root_names<S: AsRef<str>>(paths: &[S]) -> Vec<&str> {
    let mut names: Vec<&str> = paths
        .iter()
        .filter_map(|path| path.as_ref().split('/').find(|part| !part.is_empty()))
        .collect();
    names.sort_unstable();
    names.dedup();
    names
}

pub(crate) fn fold(name: &str) -> String {
    to_nfc(name).to_lowercase()
}

/// A vault name that is free at the root of a repository whose paths are `existing`: `preferred` if it is,
/// else `preferred 2`, `preferred 3`, … (case aside, spec §5 rule 6). It does not check that `preferred` is
/// a valid name; [`plan_setup`] does.
pub fn free_vault_name<S: AsRef<str>>(preferred: &str, existing: &[S]) -> String {
    let roots = root_names(existing);
    crate::naming::free_name(preferred, "", &roots)
        .trim_end_matches('.')
        .to_string()
}

/// Decide what to add to a repository that is not a Fjord repository. Pure.
///
/// `existing` is the path of every file in the repository (directories need not be listed), and
/// `gitattributes` is the text of its `.gitattributes` if it has one. The plan is one new `fjord.json`,
/// one new plaintext vault (its manifest and a starter note), and, only if the repository lacks spec §9's
/// merge guard, a `.gitattributes` that has it. Of everything that is there, nothing is changed, renamed or
/// removed; the one file that can grow is `.gitattributes`, by a line at its end.
///
/// What this leaves out of what [`plan_with`] writes is deliberate: a `README.md`, a `.gitignore` and a
/// `* text=auto eol=lf` rule would each clash with, or silently change, a repository that is somebody's
/// already.
pub fn plan_setup<S: AsRef<str>>(
    setup: &Setup,
    origin: &Origin,
    existing: &[S],
    gitattributes: Option<&str>,
) -> Result<SetupPlan, SetupError> {
    let roots = root_names(existing);
    if roots.iter().any(|name| fold(name) == REPOSITORY_MANIFEST) {
        return Err(SetupError::AlreadyFjord);
    }

    let vault = to_nfc(&setup.vault);
    let invalid = |reason: &str| SetupError::InvalidVaultName {
        name: setup.vault.clone(),
        reason: reason.to_string(),
    };
    if vault.is_empty() {
        return Err(invalid("it is empty"));
    }
    if vault.starts_with('.') {
        return Err(invalid("it would be a hidden directory"));
    }
    if let Some(code) = check_component(&vault).first() {
        return Err(invalid(&code.to_string()));
    }
    if roots.iter().any(|name| fold(name) == fold(&vault)) {
        return Err(SetupError::VaultNameTaken(vault));
    }

    let has_gitattributes = roots.contains(&".gitattributes");
    let guard_change = match (has_gitattributes, gitattributes) {
        (false, _) => Some((SETUP_GITATTRIBUTES.to_string(), FileChange::Create)),
        (true, None) => return Err(SetupError::GitattributesNotRead),
        (true, Some(text)) if has_merge_guard(text) => None,
        (true, Some(text)) => {
            let mut contents = text.to_string();
            if !contents.is_empty() && !contents.ends_with('\n') {
                contents.push('\n');
            }
            contents.push_str(SETUP_GITATTRIBUTES);
            Some((contents, FileChange::Append))
        }
    };

    let settings = Settings {
        name: setup.repository_name.clone(),
        encrypt_private: false,
        generator: setup.generator.clone(),
    };
    let mut files = vec![SetupFile {
        path: REPOSITORY_MANIFEST.to_string(),
        contents: repository_manifest(
            &settings,
            &origin.repository_id,
            &origin.created_at,
            &[(vault.as_str(), origin.vault_id.as_str())],
        ),
        change: FileChange::Create,
    }];
    if let Some((contents, change)) = guard_change {
        files.push(SetupFile {
            path: ".gitattributes".to_string(),
            contents,
            change,
        });
    }
    files.push(SetupFile {
        path: format!("{vault}/{VAULT_MANIFEST}"),
        contents: vault_manifest(&vault, &origin.vault_id, &origin.created_at, false),
        change: FileChange::Create,
    });
    files.push(SetupFile {
        path: format!("{vault}/welcome.md"),
        contents: SETUP_WELCOME
            .replace("{{id}}", &origin.welcome_id)
            .replace("{{created}}", &origin.created_at)
            .replace("{{vault}}", &vault),
        change: FileChange::Create,
    });

    Ok(SetupPlan {
        files,
        repository_id: origin.repository_id.clone(),
        vault_id: origin.vault_id.clone(),
        created_at: origin.created_at.clone(),
    })
}

// --- Setting up a repository of a kind (spec §3.1) ------------------------------------------------------

/// The kind a repository that is not a Fjord repository is set up as, beyond [`plan_setup`]'s drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupKind {
    /// One vault of entries, plaintext or encrypted. An encrypted one names its files by id inside a tar container (spec §7.2,
    /// §11.2) and is written to `recipients` at once, as [`plan_vault`]'s are.
    Journal {
        vault: String,
        encrypted: bool,
        recipients: Vec<String>,
    },
    /// One plaintext vault, [`SITE_VAULT`], and the engine's files around it.
    Ssg { engine: SiteEngine },
}

/// What to add to a repository that is not a Fjord repository, to make it one of a kind.
#[derive(Debug, Clone)]
pub struct KindSetup {
    /// `fjord.json`'s `name`. Spec §3.
    pub repository_name: String,
    /// Tool and version, recorded in `generator`. Spec §3.
    pub generator: String,
    pub kind: SetupKind,
}

/// Why a repository cannot be set up as a kind: [`plan_setup`]'s reasons, [`plan_vault`]'s for the one vault, or a file of a site's
/// engine that is there already, which is somebody's and not ours to write over.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KindSetupError {
    #[error(transparent)]
    Setup(SetupError),
    #[error(transparent)]
    Vault(VaultError),
    #[error("\"{0}\" is already in this repository, and a site's engine would need it")]
    FileTaken(String),
}

impl KindSetupError {
    /// A stable name for the kind of failure, for a caller that reports it.
    pub fn code(&self) -> &'static str {
        match self {
            KindSetupError::Setup(error) => error.code(),
            KindSetupError::Vault(error) => error.code(),
            KindSetupError::FileTaken(_) => "file_taken",
        }
    }
}

/// Decide what to add to a repository that is not a Fjord repository to make it a journal or a site (spec §3.1). Pure.
///
/// Additive, as [`plan_setup`] is: `fjord.json` with the kind, the one vault (made by [`plan_vault`], so a journal's encryption is
/// exactly an added vault's), spec §9's merge guard where it is missing, and for a site its engine's files and a first post. A
/// file the engine would need that is already there is refused, not written over; a `.gitignore` that is there is left as it is.
pub fn plan_setup_kind<S: AsRef<str>>(
    setup: &KindSetup,
    origin: &Origin,
    existing: &[S],
    gitattributes: Option<&str>,
) -> Result<SetupPlan, KindSetupError> {
    let roots = root_names(existing);
    if roots.iter().any(|name| fold(name) == REPOSITORY_MANIFEST) {
        return Err(KindSetupError::Setup(SetupError::AlreadyFjord));
    }

    let (kind, kind_settings, vault, encrypted, recipients) = match &setup.kind {
        SetupKind::Journal {
            vault,
            encrypted,
            recipients,
        } => (
            crate::manifest::Kind::JOURNAL,
            None,
            vault.clone(),
            *encrypted,
            recipients.clone(),
        ),
        SetupKind::Ssg { engine } => (
            crate::manifest::Kind::SSG,
            Some(json!({ field::ENGINE: engine.as_str() })),
            SITE_VAULT.to_string(),
            false,
            Vec::new(),
        ),
    };

    // `fjord.json` with the kind and no vault yet, which `plan_vault` then lists the vault in.
    let mut manifest = serde_json::Map::new();
    manifest.insert(field::FJORD.into(), json!(FORMAT_VERSION));
    manifest.insert(field::ID.into(), json!(origin.repository_id));
    manifest.insert(field::NAME.into(), json!(setup.repository_name));
    manifest.insert(field::CREATED_AT.into(), json!(origin.created_at));
    manifest.insert(field::GENERATOR.into(), json!(setup.generator));
    manifest.insert(field::KIND.into(), json!(kind));
    if let Some(kind_settings) = kind_settings {
        manifest.insert(kind.into(), kind_settings);
    }
    manifest.insert(field::VAULTS.into(), json!([]));
    let manifest = pretty(&serde_json::Value::Object(manifest));

    let planned = plan_vault(
        &VaultSetup {
            name: vault.clone(),
            encrypted,
            id_naming: encrypted,
            recipients,
        },
        manifest.as_bytes(),
        existing,
        gitattributes,
        &origin.vault_id,
        &origin.created_at,
    )
    .map_err(KindSetupError::Vault)?;
    let mut files: Vec<SetupFile> = planned
        .files
        .into_iter()
        .map(|file| SetupFile {
            // `fjord.json` is new here, though `plan_vault` rewrites an existing one.
            change: if file.path == REPOSITORY_MANIFEST {
                FileChange::Create
            } else {
                file.change
            },
            ..file
        })
        .collect();

    // An encrypted vault brought the merge guard with it; a plaintext one did not, and §9 asks for it in every repository.
    if !files.iter().any(|file| file.path == ".gitattributes") {
        match (roots.contains(&".gitattributes"), gitattributes) {
            (false, _) => files.push(SetupFile {
                path: ".gitattributes".to_string(),
                contents: SETUP_GITATTRIBUTES.to_string(),
                change: FileChange::Create,
            }),
            (true, None) => {
                return Err(KindSetupError::Setup(SetupError::GitattributesNotRead));
            }
            (true, Some(text)) if has_merge_guard(text) => {}
            (true, Some(text)) => {
                let mut contents = text.to_string();
                if !contents.is_empty() && !contents.ends_with('\n') {
                    contents.push('\n');
                }
                contents.push_str(SETUP_GITATTRIBUTES);
                files.push(SetupFile {
                    path: ".gitattributes".to_string(),
                    contents,
                    change: FileChange::Append,
                });
            }
        }
    }

    if let SetupKind::Ssg { engine } = &setup.kind {
        // The site's files, as a new repository of the kind has them, less what a repository that is somebody's has already.
        let site = plan_site(
            &KindSettings {
                name: setup.repository_name.clone(),
                generator: setup.generator.clone(),
                kind: KindChoice::Ssg { engine: *engine },
            },
            origin,
            *engine,
        );
        let taken = |path: &str| {
            existing
                .iter()
                .any(|there| fold(there.as_ref()) == fold(path))
        };
        for file in site.files {
            let ours = file.path == REPOSITORY_MANIFEST
                || file.path == ".gitattributes"
                || file.path == format!("{SITE_VAULT}/{VAULT_MANIFEST}");
            if ours {
                continue;
            }
            if file.path == ".gitignore" || file.path == "README.md" {
                // Somebody's own, if there is one; the site builds without ours.
                if taken(&file.path) {
                    continue;
                }
            } else if taken(&file.path) {
                return Err(KindSetupError::FileTaken(file.path));
            }
            files.push(SetupFile {
                path: file.path,
                contents: file.contents,
                change: FileChange::Create,
            });
        }
    }

    Ok(SetupPlan {
        files,
        repository_id: origin.repository_id.clone(),
        vault_id: origin.vault_id.clone(),
        created_at: origin.created_at.clone(),
    })
}

/// The `.gitattributes` a setup creates where there is none: only what spec §9 requires. (A new repository
/// from [`plan_with`] gets the fuller template, which also normalises line endings.)
pub(crate) const SETUP_GITATTRIBUTES: &str =
    "# Fjord: never diff or merge ciphertext (spec §9).\n*.age binary -diff -merge\n";

/// The files a new vault consists of. Spec §2.3, §4.
///
/// Paths are relative to the vault's own directory, so the caller decides
/// where it goes. `recipients` are written into the recipients file of an
/// encrypted vault, which makes it writable straight away: §6.2 makes a
/// vault with none valid and unwritable, and `fjord verify` warns about it.
/// They are **not validated here** — the caller has already done that, with
/// [`crate::crypto::check_recipient`], before anything reaches the disk —
/// and they are ignored for a plaintext vault, which has no such file.
pub fn vault_files(
    name: &str,
    id: &str,
    created_at: &str,
    encrypted: bool,
    file_naming: &str,
    recipients: &[String],
) -> Vec<PlannedFile> {
    let mut files = vec![PlannedFile {
        path: VAULT_MANIFEST.to_string(),
        contents: vault_manifest_with(name, id, created_at, encrypted, file_naming),
    }];
    if encrypted {
        let mut contents = RECIPIENTS.to_string();
        if !recipients.is_empty() {
            // The same shape as the conforming fixture: the instructions,
            // a blank line, then one key per line.
            contents = contents.trim_end().to_string();
            contents.push_str("\n\n");
            for recipient in recipients {
                contents.push_str(recipient.trim());
                contents.push('\n');
            }
        }
        files.push(PlannedFile {
            path: CONVENTIONAL_RECIPIENTS_FILE.to_string(),
            contents,
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

/// The text of the §6.5 plaintext guard `.gitignore` an encrypted vault has, so that a client can tell its own from one a person wrote.
pub fn vault_guard() -> &'static str {
    VAULT_GITIGNORE
}

/// Why a vault's encryption cannot be changed (RFC 0003). Nothing is written when one is returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConvertError {
    /// `fjord.vault.json` is not a JSON object.
    Unreadable,
    /// Encrypting a vault that is already encrypted.
    AlreadyEncrypted,
    /// Decrypting a vault that is not encrypted.
    NotEncrypted,
    /// A vault with no recipients could be written by nobody (§6.2).
    NoRecipients,
}

impl ConvertError {
    /// A stable name for the refusal, for a client that reports it (the web's `planVaultEncryption`).
    pub fn code(&self) -> &'static str {
        match self {
            ConvertError::Unreadable => "manifest_unusable",
            ConvertError::AlreadyEncrypted => "already_encrypted",
            ConvertError::NotEncrypted => "not_encrypted",
            ConvertError::NoRecipients => "no_recipients",
        }
    }
}

/// What making a plaintext vault an encrypted one changes (spec §4.1, §6.5): its manifest, and the two files an encrypted vault
/// has. Paths are relative to the vault's directory. The vault's own files are not touched here: they are encrypted by a checkout
/// (§6.6), which is how plaintext leaves a vault.
#[derive(Debug, Clone)]
pub struct EncryptPlan {
    /// The vault's `fjord.vault.json`, with `encryption` set and every other field, known or not, where it was.
    pub manifest: String,
    /// The recipients file and the §6.5 plaintext guard.
    pub files: Vec<PlannedFile>,
}

/// `manifest` (a vault's `fjord.vault.json`) as an encrypted vault's: `encryption` set to age with the conventional recipients
/// file, plain file naming. The caller has validated `recipients` with [`crate::crypto::check_recipient`].
pub fn plan_encrypt_vault(
    manifest: &[u8],
    recipients: &[String],
) -> Result<EncryptPlan, ConvertError> {
    let parsed =
        crate::manifest::Manifest::parse(manifest).map_err(|_| ConvertError::Unreadable)?;
    if matches!(
        parsed.encryption(),
        crate::manifest::EncryptionField::Object(_)
    ) {
        return Err(ConvertError::AlreadyEncrypted);
    }
    if recipients.is_empty() {
        return Err(ConvertError::NoRecipients);
    }
    let mut raw = parsed.raw().clone();
    raw.insert(
        field::ENCRYPTION.to_string(),
        json!({
            field::TOOL: TOOL_AGE,
            field::RECIPIENTS: CONVENTIONAL_RECIPIENTS_FILE,
            field::SUFFIX: SUFFIX_AGE,
            field::CONTAINER: "none",
            field::ARMOR: false,
        }),
    );
    raw.insert(field::FILE_NAMING.to_string(), json!("plain"));

    let mut files = vault_files("", "", "", true, "plain", recipients);
    files.remove(0); // the manifest it would make is not this vault's: this vault keeps its id, name and every other field
    Ok(EncryptPlan {
        manifest: pretty(&serde_json::Value::Object(raw)),
        files,
    })
}

/// `manifest` as a plaintext vault's: `encryption` null, plain file naming, every other field where it was.
pub fn plan_decrypt_vault(manifest: &[u8]) -> Result<String, ConvertError> {
    let parsed =
        crate::manifest::Manifest::parse(manifest).map_err(|_| ConvertError::Unreadable)?;
    if !matches!(
        parsed.encryption(),
        crate::manifest::EncryptionField::Object(_)
    ) {
        return Err(ConvertError::NotEncrypted);
    }
    let mut raw = parsed.raw().clone();
    raw.insert(field::ENCRYPTION.to_string(), serde_json::Value::Null);
    raw.insert(field::FILE_NAMING.to_string(), json!("plain"));
    Ok(pretty(&serde_json::Value::Object(raw)))
}

/// `fjord.json` with its kind changed to `kind` (spec §3.1), every other field kept where it was, settings objects of other kinds
/// included (§3.1 and §10.1 keep them). A site's `engine` is written into its `ssg` object, whose other fields are kept too. Whether
/// the repository then keeps the kind's rules is [`crate::manifest::kind_rule`]'s to say, before this is written.
pub fn with_kind(
    manifest: &crate::manifest::Manifest,
    kind: &crate::manifest::Kind,
    engine: Option<SiteEngine>,
) -> String {
    let mut raw = manifest.raw().clone();
    raw.insert(field::KIND.to_string(), json!(kind.as_str()));
    if let Some(engine) = engine {
        let mut settings = match raw.get(field::SSG) {
            Some(serde_json::Value::Object(existing)) => existing.clone(),
            _ => serde_json::Map::new(),
        };
        settings.insert(field::ENGINE.to_string(), json!(engine.as_str()));
        raw.insert(field::SSG.to_string(), serde_json::Value::Object(settings));
    }
    pretty(&serde_json::Value::Object(raw))
}

/// A vault to add to a Fjord repository (`fjord vault add`, and *Add a vault* in the web client).
#[derive(Debug, Clone)]
pub struct VaultSetup {
    /// The vault's directory, at the root. It is also its display name (spec §2.3).
    pub name: String,
    pub encrypted: bool,
    /// Name the vault's files by identifier (spec §7.2): only for an encrypted vault.
    pub id_naming: bool,
    /// The recipients of an encrypted vault, one key each: written to its recipients file, which makes it writable at once.
    pub recipients: Vec<String>,
}

/// Everything [`plan_vault`] adds. **Additive**: every file is new except `fjord.json`, which gains the vault's entry, and possibly
/// `.gitattributes`, which gains a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultPlan {
    pub files: Vec<SetupFile>,
    pub vault_id: String,
    pub created_at: String,
    /// The recipients registered, checked and without repeats.
    pub recipients: Vec<String>,
}

/// Why a vault cannot be added, or not like this.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultError {
    /// `fjord.json` is not there, or cannot be read: it is not ours to rewrite.
    #[error("fjord.json is not usable: {0}")]
    ManifestUnusable(String),
    /// The repository declares a newer format than this build implements: read-only (spec §10.1, invariant 4).
    #[error("this repository declares Fjord format version {found}, and this build implements {supported}; it may be read but not written")]
    NewerVersion { found: i64, supported: u32 },
    /// The name cannot be a directory a vault lives in.
    #[error("\"{name}\" cannot be the name of a vault: {reason}")]
    InvalidName { name: String, reason: String },
    /// Something at the root already has that name, case aside (spec §5 rule 6).
    #[error("\"{0}\" is already used in this repository")]
    NameTaken(String),
    /// Recipients were given for a vault with no encryption, which would be dropped, and the vault left readable by everyone.
    #[error("recipients need an encrypted vault: a plaintext vault has none, so the key would be dropped and the vault left readable by everyone")]
    RecipientsNeedEncryption,
    /// Spec §7.2: identifier names on a plaintext vault conceal nothing and destroy browsability.
    #[error("naming files by id needs an encrypted vault: on a plaintext vault it hides nothing and makes the vault unbrowsable, which spec §7.2 requires clients to reject")]
    IdNamingNeedsEncryption,
    /// A recipient `age` cannot use. The key is shown only if it is not a secret one.
    #[error("{recipient}: {reason}")]
    BadRecipient { recipient: String, reason: String },
    /// This build cannot check recipients (no `crypto`), so it cannot honour any.
    #[error("this build cannot check recipients")]
    RecipientsUnsupported,
    /// There is a `.gitattributes` but its text was not given, so the guard cannot be added to it.
    #[error(".gitattributes is there but its text was not supplied")]
    GitattributesNotRead,
}

impl VaultError {
    /// A stable name for the kind of failure, for a caller that reports it.
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::ManifestUnusable(_) => "manifest_unusable",
            VaultError::NewerVersion { .. } => "newer_version",
            VaultError::InvalidName { .. } => "invalid_name",
            VaultError::NameTaken(_) => "name_taken",
            VaultError::RecipientsNeedEncryption => "recipients_need_encryption",
            VaultError::IdNamingNeedsEncryption => "id_naming_needs_encryption",
            VaultError::BadRecipient { .. } => "bad_recipient",
            VaultError::RecipientsUnsupported => "recipients_unsupported",
            VaultError::GitattributesNotRead => "gitattributes_not_read",
        }
    }
}

/// Decide what to add to a Fjord repository for a new vault. Pure: the identifier and the time are the caller's.
///
/// `manifest` is the text of the repository's `fjord.json`, `existing` the path of every file in the repository (directories need not
/// be listed) and `gitattributes` the text of its `.gitattributes` if it has one (needed only for an encrypted vault, which adds spec §9's
/// merge guard if the repository lacks it). Everything is checked before anything is planned, so a request that cannot be honoured
/// plans nothing: a vault made with some of its keys is the worst result.
pub fn plan_vault<S: AsRef<str>>(
    setup: &VaultSetup,
    manifest: &[u8],
    existing: &[S],
    gitattributes: Option<&str>,
    vault_id: &str,
    created_at: &str,
) -> Result<VaultPlan, VaultError> {
    let parsed = crate::manifest::Manifest::parse(manifest)
        .map_err(|err| VaultError::ManifestUnusable(err.to_string()))?;
    if let Some(found) = parsed.version() {
        if found > i64::from(FORMAT_VERSION) {
            return Err(VaultError::NewerVersion {
                found,
                supported: FORMAT_VERSION,
            });
        }
    }

    if !setup.recipients.is_empty() && !setup.encrypted {
        return Err(VaultError::RecipientsNeedEncryption);
    }
    if setup.id_naming && !setup.encrypted {
        return Err(VaultError::IdNamingNeedsEncryption);
    }

    #[cfg(not(feature = "crypto"))]
    if !setup.recipients.is_empty() {
        return Err(VaultError::RecipientsUnsupported);
    }
    #[cfg_attr(not(feature = "crypto"), allow(unused_mut))]
    let mut accepted: Vec<String> = Vec::new();
    #[cfg(feature = "crypto")]
    for recipient in &setup.recipients {
        if let Err(reason) = crate::crypto::check_recipient(recipient) {
            return Err(VaultError::BadRecipient {
                recipient: crate::crypto::display_safe(recipient),
                reason,
            });
        }
        // The same key twice is harmless to age and pointless to store.
        let trimmed = recipient.trim().to_string();
        if !accepted.contains(&trimmed) {
            accepted.push(trimmed);
        }
    }

    // A vault is a directory at the repository root (spec §2.3), so its name is one path component and the §5 rules apply to it.
    let name = to_nfc(&setup.name);
    let invalid = |reason: &str| VaultError::InvalidName {
        name: setup.name.clone(),
        reason: reason.to_string(),
    };
    if name.is_empty() {
        return Err(invalid("it is empty"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(invalid(
            "a vault is a single directory at the repository root (spec §2.3)",
        ));
    }
    if name.starts_with('.') {
        return Err(invalid("it would be a hidden directory"));
    }
    if let Some(code) = check_component(&name).first() {
        return Err(invalid(&code.to_string()));
    }
    let roots = root_names(existing);
    if roots.iter().any(|root| fold(root) == fold(&name)) {
        return Err(VaultError::NameTaken(name));
    }

    let file_naming = if setup.id_naming { "id" } else { "plain" };
    let mut files: Vec<SetupFile> = vault_files(
        &name,
        vault_id,
        created_at,
        setup.encrypted,
        file_naming,
        &accepted,
    )
    .into_iter()
    .map(|file| SetupFile {
        path: format!("{name}/{}", file.path),
        contents: file.contents,
        change: FileChange::Create,
    })
    .collect();

    // The manifest first in the list, as the CLI writes it first: a vault the manifest does not list is only a warning (W601), where a
    // manifest listing a vault that was never made is an error (E106).
    let rewritten = with_vault_entry(&parsed, &name, vault_id)
        .map_err(|err| VaultError::ManifestUnusable(err.to_string()))?;
    files.insert(
        0,
        SetupFile {
            path: REPOSITORY_MANIFEST.to_string(),
            contents: rewritten,
            change: FileChange::Append,
        },
    );

    // Spec §9: ciphertext is never diffed or merged. A repository made by `fjord init` has the line; one that was not might not.
    if setup.encrypted {
        let has_gitattributes = roots.contains(&".gitattributes");
        match (has_gitattributes, gitattributes) {
            (false, _) => files.push(SetupFile {
                path: ".gitattributes".to_string(),
                contents: SETUP_GITATTRIBUTES.to_string(),
                change: FileChange::Create,
            }),
            (true, None) => return Err(VaultError::GitattributesNotRead),
            (true, Some(text)) if has_merge_guard(text) => {}
            (true, Some(text)) => {
                let mut contents = text.to_string();
                if !contents.is_empty() && !contents.ends_with('\n') {
                    contents.push('\n');
                }
                contents.push_str(SETUP_GITATTRIBUTES);
                files.push(SetupFile {
                    path: ".gitattributes".to_string(),
                    contents,
                    change: FileChange::Append,
                });
            }
        }
    }

    Ok(VaultPlan {
        files,
        vault_id: vault_id.to_string(),
        created_at: created_at.to_string(),
        recipients: accepted,
    })
}

/// Write a plan to disk, creating `root` and any parent directories.
///
/// Never overwrites: an existing file is [`Error::Exists`], and the caller
/// decides what to tell the user.
#[cfg(feature = "native")]
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

#[cfg(feature = "native")]
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
pub(crate) fn pretty(value: &serde_json::Value) -> String {
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

    /// A fixed moment and fixed randomness, so these tests need no clock and say the same thing every time.
    fn origin() -> Origin {
        let random: Vec<u8> = (0..Origin::ENTROPY_BYTES as u8)
            .map(|i| i.wrapping_mul(7).wrapping_add(3))
            .collect();
        Origin::from_entropy(1_792_000_000_000, &random).expect("an origin")
    }

    fn plan(settings: &Settings) -> Plan {
        plan_with(settings, &origin())
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

    #[cfg(feature = "native")]
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

    #[cfg(feature = "native")]
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

    // --- The origin ---

    #[test]
    fn an_origin_is_made_from_the_time_and_the_randomness_it_is_given() {
        let made = origin();
        assert_eq!(made, origin(), "the same inputs must give the same origin");
        assert!(scalar::is_rfc3339_utc(&made.created_at));
        assert_eq!(
            made.created_at,
            scalar::rfc3339_utc_from_unix(1_792_000_000).expect("a date")
        );

        let mut ids = vec![
            made.repository_id.clone(),
            made.vault_id.clone(),
            made.welcome_id.clone(),
            made.private_vault_id.clone(),
        ];
        for id in &ids {
            assert!(scalar::is_ulid(id), "{id} is not an identifier");
        }
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 4, "no two identifiers may be the same");

        // Different randomness, different identifiers.
        let other: Vec<u8> = (0..Origin::ENTROPY_BYTES as u8).rev().collect();
        let changed = Origin::from_entropy(1_792_000_000_000, &other).expect("an origin");
        assert_ne!(changed.repository_id, made.repository_id);
    }

    #[test]
    fn too_little_randomness_or_a_time_that_is_no_date_makes_no_origin() {
        let enough = vec![1u8; Origin::ENTROPY_BYTES];
        assert!(Origin::from_entropy(0, &enough[..Origin::ENTROPY_BYTES - 1]).is_none());
        assert!(Origin::from_entropy(0, &[]).is_none());
        assert!(Origin::from_entropy(u64::MAX, &enough).is_none());
        assert!(Origin::from_entropy(0, &enough).is_some());
    }

    #[test]
    fn a_plan_is_pure_the_same_origin_gives_the_same_plan() {
        let first = plan(&settings(true));
        let second = plan(&settings(true));
        assert_eq!(first.paths(), second.paths());
        for (a, b) in first.files.iter().zip(&second.files) {
            assert_eq!(a.contents, b.contents, "{}", a.path);
        }
        assert_eq!(first.repository_id, origin().repository_id);
    }

    // --- The merge guard ---

    #[test]
    fn the_merge_guard_is_what_verify_asks_for() {
        assert!(has_merge_guard("*.age binary -diff -merge\n"));
        assert!(has_merge_guard(
            "*       text=auto eol=lf\n*.age\tbinary  -merge\n"
        ));
        assert!(has_merge_guard("# note\n\n*.age -merge"));
        assert!(!has_merge_guard(""));
        assert!(!has_merge_guard("# *.age -merge\n"));
        assert!(!has_merge_guard("*.age binary -diff\n"));
        assert!(!has_merge_guard("*.md -merge\n"));
        assert!(!has_merge_guard("*.age.bak -merge\n"));
        assert!(has_merge_guard(MERGE_GUARD));
        assert!(has_merge_guard(SETUP_GITATTRIBUTES));
        assert!(has_merge_guard(GITATTRIBUTES));
    }

    // --- Setting up a repository that is not a Fjord repository ---

    fn setup(vault: &str) -> Setup {
        Setup {
            repository_name: "notes".to_string(),
            vault: vault.to_string(),
            generator: "fjord-web test".to_string(),
        }
    }

    const CODE_REPO: &[&str] = &[
        "README.md",
        "src/main.rs",
        "src/lib/mod.rs",
        "Cargo.toml",
        ".gitignore",
    ];

    fn paths_of(plan: &SetupPlan) -> Vec<&str> {
        plan.files.iter().map(|file| file.path.as_str()).collect()
    }

    fn file<'a>(plan: &'a SetupPlan, path: &str) -> &'a SetupFile {
        plan.files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("no {path} in {:?}", paths_of(plan)))
    }

    #[test]
    fn a_setup_adds_a_manifest_a_vault_and_the_guard_and_nothing_else() {
        let planned = plan_setup(&setup("Public"), &origin(), CODE_REPO, None).expect("a plan");
        assert_eq!(
            paths_of(&planned),
            vec![
                "fjord.json",
                ".gitattributes",
                "Public/fjord.vault.json",
                "Public/welcome.md"
            ]
        );
        assert!(planned
            .files
            .iter()
            .all(|file| file.change == FileChange::Create));

        // None of the files the repository has is among them: no README.md, no .gitignore.
        for existing in CODE_REPO {
            assert!(!paths_of(&planned).contains(existing), "{existing}");
        }
    }

    #[test]
    fn the_manifests_name_the_repository_and_the_vault_and_agree() {
        let planned = plan_setup(&setup("Notes"), &origin(), CODE_REPO, None).expect("a plan");
        let repository =
            Manifest::parse(file(&planned, "fjord.json").contents.as_bytes()).expect("fjord.json");
        assert_eq!(repository.string(field::NAME), Some("notes"));
        assert_eq!(repository.string(field::GENERATOR), Some("fjord-web test"));
        assert_eq!(
            repository.string(field::ID),
            Some(planned.repository_id.as_str())
        );
        assert_eq!(
            repository.string(field::CREATED_AT),
            Some(planned.created_at.as_str())
        );

        let vaults = repository
            .raw()
            .get(field::VAULTS)
            .and_then(|value| value.as_array())
            .expect("vaults");
        assert_eq!(vaults.len(), 1);
        assert_eq!(vaults[0][field::PATH], "Notes");
        assert_eq!(vaults[0][field::ID], planned.vault_id.as_str());

        let vault = Manifest::parse(file(&planned, "Notes/fjord.vault.json").contents.as_bytes())
            .expect("manifest");
        assert_eq!(vault.string(field::ID), Some(planned.vault_id.as_str()));
        assert_eq!(vault.string(field::NAME), Some("Notes"));
        assert!(
            vault
                .raw()
                .get(field::ENCRYPTION)
                .is_some_and(|value| value.is_null()),
            "a plaintext vault"
        );
    }

    #[test]
    fn a_setup_writes_the_same_vault_that_a_new_repository_does() {
        // The Public vault of `fjord init` and a set-up vault named the same, from one origin: the same
        // manifest, byte for byte. They are built by one function.
        let new = plan(&settings(true));
        let planned = plan_setup(&setup("Public"), &origin(), CODE_REPO, None).expect("a plan");
        let of_init = |path: &str| {
            new.files
                .iter()
                .find(|f| f.path == path)
                .expect(path)
                .contents
                .clone()
        };
        assert_eq!(
            file(&planned, "Public/fjord.vault.json").contents,
            of_init("Public/fjord.vault.json")
        );
        assert_eq!(planned.vault_id, new.vaults[0].1);
    }

    #[test]
    fn the_starter_note_is_a_doc_that_says_what_was_added() {
        let planned = plan_setup(&setup("My notes"), &origin(), CODE_REPO, None).expect("a plan");
        let welcome = file(&planned, "My notes/welcome.md");
        let frontmatter = match crate::doc::parse(&welcome.contents) {
            crate::doc::Parse::Present { frontmatter, .. } => frontmatter,
            other => panic!("no frontmatter: {other:?}"),
        };
        assert_eq!(frontmatter.doc_id(), Some(origin().welcome_id.as_str()));
        assert_eq!(frontmatter.created(), Some(planned.created_at.as_str()));
        assert!(!welcome.contents.contains("{{"), "a placeholder survived");
        assert!(welcome.contents.contains("\"My notes\""));
        assert!(
            !welcome.contents.contains("Public"),
            "it must not name a vault it did not make"
        );
    }

    #[test]
    fn a_gitattributes_without_the_guard_gains_it_and_loses_nothing() {
        let before = "* text=auto\n*.png binary\n";
        let existing: Vec<&str> = [CODE_REPO, &[".gitattributes"]].concat();
        let planned =
            plan_setup(&setup("Public"), &origin(), &existing, Some(before)).expect("a plan");
        let changed = file(&planned, ".gitattributes");
        assert_eq!(changed.change, FileChange::Append);
        assert!(changed.contents.starts_with(before), "{}", changed.contents);
        assert!(has_merge_guard(&changed.contents));
        assert_eq!(changed.contents.matches("*.png binary").count(), 1);

        // A file with no final newline is not run into the guard.
        let planned = plan_setup(&setup("Public"), &origin(), &existing, Some("* text=auto"))
            .expect("a plan");
        let contents = &file(&planned, ".gitattributes").contents;
        assert!(contents.starts_with("* text=auto\n# Fjord"), "{contents:?}");

        // An empty one.
        let planned = plan_setup(&setup("Public"), &origin(), &existing, Some("")).expect("a plan");
        assert_eq!(
            file(&planned, ".gitattributes").contents,
            SETUP_GITATTRIBUTES
        );
    }

    #[test]
    fn a_gitattributes_that_has_the_guard_is_left_alone() {
        let existing: Vec<&str> = [CODE_REPO, &[".gitattributes"]].concat();
        let planned = plan_setup(
            &setup("Public"),
            &origin(),
            &existing,
            Some("*.age -merge\n"),
        )
        .expect("a plan");
        assert!(
            !paths_of(&planned).contains(&".gitattributes"),
            "{:?}",
            paths_of(&planned)
        );
    }

    #[test]
    fn a_gitattributes_whose_text_was_not_given_cannot_be_added_to() {
        let existing: Vec<&str> = [CODE_REPO, &[".gitattributes"]].concat();
        let error = plan_setup(&setup("Public"), &origin(), &existing, None).expect_err("an error");
        assert_eq!(error, SetupError::GitattributesNotRead);
    }

    #[test]
    fn a_repository_that_has_a_fjord_json_is_not_set_up() {
        for existing in [
            vec!["fjord.json"],
            vec!["Public/fjord.vault.json", "fjord.json"],
            vec!["FJORD.JSON"],
        ] {
            assert_eq!(
                plan_setup(&setup("Notes"), &origin(), &existing, None).expect_err("an error"),
                SetupError::AlreadyFjord,
                "{existing:?}"
            );
        }
        // Even when the name is also taken: the first problem is the more important.
        assert_eq!(
            plan_setup(&setup("src"), &origin(), &["fjord.json", "src/a.rs"], None)
                .expect_err("an error"),
            SetupError::AlreadyFjord
        );
    }

    #[test]
    fn a_name_already_at_the_root_is_taken_whatever_its_case_and_whatever_it_is() {
        for taken in ["src", "SRC", "Src"] {
            let error =
                plan_setup(&setup(taken), &origin(), CODE_REPO, None).expect_err("an error");
            assert!(
                matches!(error, SetupError::VaultNameTaken(_)),
                "{taken}: {error:?}"
            );
        }
        // A file counts as much as a directory.
        let error =
            plan_setup(&setup("readme.md"), &origin(), CODE_REPO, None).expect_err("an error");
        assert!(matches!(error, SetupError::VaultNameTaken(_)));
        // The same name written in two normalisations is the same name.
        let error = plan_setup(&setup("caf\u{e9}"), &origin(), &["cafe\u{301}/a.md"], None)
            .expect_err("an error");
        assert!(matches!(error, SetupError::VaultNameTaken(_)));
        // A name that only starts like one that is there is free.
        assert!(plan_setup(&setup("srcs"), &origin(), CODE_REPO, None).is_ok());
    }

    #[test]
    fn a_name_that_cannot_be_a_directory_is_refused_with_the_reason() {
        let too_long = "a".repeat(256);
        for bad in [
            "",
            ".hidden",
            ".git",
            "a/b",
            "a\\b",
            "bad:name",
            "q?",
            "trailing.",
            "trailing ",
            "CON",
            "nul",
            "tab\tname",
            too_long.as_str(),
        ] {
            let error = plan_setup(&setup(bad), &origin(), CODE_REPO, None).expect_err(bad);
            assert!(
                matches!(error, SetupError::InvalidVaultName { .. }),
                "{bad:?}: {error:?}"
            );
            assert_eq!(error.code(), "invalid_vault_name");
        }
    }

    #[test]
    fn a_vault_name_is_written_in_nfc() {
        let planned =
            plan_setup(&setup("cafe\u{301}"), &origin(), CODE_REPO, None).expect("a plan");
        assert!(
            paths_of(&planned).contains(&"caf\u{e9}/fjord.vault.json"),
            "{:?}",
            paths_of(&planned)
        );
        for file in &planned.files {
            assert!(
                crate::path::to_nfc(&file.path) == file.path,
                "{}",
                file.path
            );
        }
    }

    #[test]
    fn a_free_vault_name_is_numbered_after_what_is_there() {
        assert_eq!(free_vault_name("Public", CODE_REPO), "Public");
        assert_eq!(free_vault_name("Public", &["Public/a.md"]), "Public 2");
        assert_eq!(
            free_vault_name("Public", &["public/a.md", "Public 2"]),
            "Public 3"
        );
        assert_eq!(free_vault_name("src", CODE_REPO), "src 2");
        // The name it finds is one a setup accepts.
        let name = free_vault_name("src", CODE_REPO);
        assert!(plan_setup(&setup(&name), &origin(), CODE_REPO, None).is_ok());
    }

    #[test]
    fn every_path_of_a_setup_passes_the_path_rules() {
        let planned = plan_setup(&setup("Public"), &origin(), CODE_REPO, None).expect("a plan");
        for file in &planned.files {
            for part in file.path.split('/') {
                assert!(
                    check_component(part).is_empty(),
                    "{} breaks a path rule",
                    file.path
                );
            }
        }
    }

    /// The point of it all: a repository that has had the setup applied is a conforming Fjord repository,
    /// whatever it was before.
    #[cfg(feature = "native")]
    #[test]
    fn a_repository_that_was_set_up_passes_verify() {
        use crate::verify::{verify, Options};

        let cases: [(&str, Option<&str>); 4] = [
            ("no .gitattributes", None),
            ("one without the guard", Some("* text=auto\n*.png binary\n")),
            ("one without a final newline", Some("*.png binary")),
            ("one with the guard", Some("*.age binary -merge\n")),
        ];
        for (name, gitattributes) in cases {
            let temp = tempfile::tempdir().expect("tempdir");
            let root = temp.path();
            std::fs::create_dir_all(root.join("src")).expect("dir");
            std::fs::write(root.join("README.md"), "# Mine\n").expect("write");
            std::fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("write");
            let mut existing = vec!["README.md".to_string(), "src/main.rs".to_string()];
            if let Some(text) = gitattributes {
                std::fs::write(root.join(".gitattributes"), text).expect("write");
                existing.push(".gitattributes".to_string());
            }

            let planned =
                plan_setup(&setup("Public"), &origin(), &existing, gitattributes).expect("a plan");
            for file in &planned.files {
                let path = root.join(&file.path);
                std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
                std::fs::write(&path, &file.contents).expect("write");
            }

            let report = verify(root, &Options::default()).expect("verify");
            assert_eq!(report.errors(), 0, "{name}: {:?}", report.diagnostics);
            assert_eq!(report.vaults.len(), 1, "{name}");

            // What was there is as it was, but for the one appended line.
            assert_eq!(
                std::fs::read_to_string(root.join("README.md")).expect("read"),
                "# Mine\n"
            );
            if let Some(before) = gitattributes {
                let after = std::fs::read_to_string(root.join(".gitattributes")).expect("read");
                assert!(after.starts_with(before), "{name}: {after:?}");
            }
        }
    }

    /// Without the setup the same repository fails verify, which is what makes the test above mean something.
    #[cfg(feature = "native")]
    #[test]
    fn a_repository_that_was_not_set_up_does_not_pass() {
        use crate::verify::{verify, Options};
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("README.md"), "# Mine\n").expect("write");
        let report = verify(temp.path(), &Options::default()).expect("verify");
        assert!(report.errors() > 0, "{:?}", report.diagnostics);
    }

    // --- Adding a vault to a Fjord repository ---

    const VAULT_ID: &str = "01jxvaaaa0000000000000000a";
    const VAULT_AT: &str = "2026-11-01T09:30:00Z";

    fn repo_manifest() -> &'static str {
        "{\n  \"fjord\": 1,\n  \"id\": \"01jxrepa00000000000000000a\",\n  \"name\": \"Mine\",\n  \"custom\": {\"keep\": true},\n  \"vaults\": [{\"path\": \"Public\", \"id\": \"01jxabthe0000000000000000a\"}]\n}\n"
    }

    fn new_vault(name: &str, encrypted: bool) -> VaultSetup {
        VaultSetup {
            name: name.to_string(),
            encrypted,
            id_naming: false,
            recipients: Vec::new(),
        }
    }

    fn plan_new(
        setup: &VaultSetup,
        existing: &[&str],
        gitattributes: Option<&str>,
    ) -> Result<VaultPlan, VaultError> {
        plan_vault(
            setup,
            repo_manifest().as_bytes(),
            existing,
            gitattributes,
            VAULT_ID,
            VAULT_AT,
        )
    }

    fn vault_paths(plan: &VaultPlan) -> Vec<&str> {
        plan.files.iter().map(|file| file.path.as_str()).collect()
    }

    #[test]
    fn a_plaintext_vault_is_its_manifest_and_an_entry_in_fjord_json() {
        let plan = plan_new(
            &new_vault("Notes", false),
            &["Public/fjord.vault.json", "fjord.json"],
            None,
        )
        .expect("a plan");
        assert_eq!(vault_paths(&plan), ["fjord.json", "Notes/fjord.vault.json"]);
        assert_eq!(plan.files[0].change, FileChange::Append);
        assert_eq!(plan.files[1].change, FileChange::Create);
        let manifest = &plan.files[1].contents;
        assert!(
            manifest.contains(VAULT_ID) && manifest.contains(VAULT_AT),
            "{manifest}"
        );
        assert!(manifest.contains("\"encryption\": null"), "{manifest}");
    }

    #[test]
    fn the_repository_manifest_keeps_what_it_had_and_lists_the_vault_after_the_others() {
        let plan = plan_new(&new_vault("Notes", false), &["fjord.json"], None).expect("a plan");
        let text = &plan.files[0].contents;
        let value: serde_json::Value = serde_json::from_str(text).expect("json");
        assert_eq!(
            value["custom"]["keep"], true,
            "an unknown field survives (invariant 3): {text}"
        );
        assert_eq!(value["name"], "Mine");
        let vaults = value["vaults"].as_array().expect("vaults");
        assert_eq!(vaults.len(), 2);
        assert_eq!(vaults[0]["path"], "Public");
        assert_eq!(vaults[1]["path"], "Notes");
        assert_eq!(vaults[1]["id"], VAULT_ID);
    }

    #[cfg(feature = "crypto")]
    fn some_recipient() -> String {
        crate::crypto::generate_identity().recipient.to_string()
    }

    #[cfg(feature = "crypto")]
    #[test]
    fn an_encrypted_vault_has_its_recipients_its_guard_and_the_repository_guard() {
        let key = some_recipient();
        let setup = VaultSetup {
            recipients: vec![key.clone(), key.clone()],
            ..new_vault("Secret", true)
        };
        let plan = plan_new(&setup, &["fjord.json"], None).expect("a plan");
        assert_eq!(
            vault_paths(&plan),
            [
                "fjord.json",
                "Secret/fjord.vault.json",
                "Secret/recipients.txt",
                "Secret/.gitignore",
                ".gitattributes"
            ]
        );
        assert_eq!(
            plan.recipients,
            std::slice::from_ref(&key),
            "a key given twice is stored once"
        );
        let recipients = &plan
            .files
            .iter()
            .find(|file| file.path.ends_with("recipients.txt"))
            .expect("recipients")
            .contents;
        assert_eq!(recipients.matches(&key).count(), 1, "{recipients}");
        assert!(plan
            .files
            .last()
            .expect("last")
            .contents
            .contains("*.age binary -diff -merge"));
        assert_eq!(plan.files.last().expect("last").change, FileChange::Create);
    }

    #[cfg(feature = "crypto")]
    #[test]
    fn an_encrypted_vault_may_be_made_with_no_key_yet() {
        let plan = plan_new(
            &new_vault("Secret", true),
            &["fjord.json", ".gitattributes"],
            Some("*.age binary -diff -merge\n"),
        )
        .expect("a plan");
        assert!(plan.recipients.is_empty());
        assert!(
            plan.files.iter().all(|file| file.path != ".gitattributes"),
            "a repository with the guard is left alone"
        );
    }

    #[cfg(feature = "crypto")]
    #[test]
    fn id_naming_is_written_into_the_manifest_of_an_encrypted_vault() {
        let setup = VaultSetup {
            id_naming: true,
            recipients: vec![some_recipient()],
            ..new_vault("Secret", true)
        };
        let plan = plan_new(
            &setup,
            &["fjord.json", ".gitattributes"],
            Some("*.age -merge\n"),
        )
        .expect("a plan");
        let manifest = &plan
            .files
            .iter()
            .find(|file| file.path == "Secret/fjord.vault.json")
            .expect("manifest")
            .contents;
        assert!(manifest.contains("\"id\""), "{manifest}");
        assert!(manifest.contains("fileNaming"), "{manifest}");
    }

    #[test]
    fn a_gitattributes_without_the_guard_gains_it_for_an_encrypted_vault_only() {
        let before = "* text=auto";
        let plan = plan_new(
            &new_vault("Secret", true),
            &["fjord.json", ".gitattributes"],
            Some(before),
        )
        .expect("a plan");
        let file = plan
            .files
            .iter()
            .find(|file| file.path == ".gitattributes")
            .expect(".gitattributes");
        assert_eq!(file.change, FileChange::Append);
        assert!(
            file.contents.starts_with("* text=auto\n"),
            "{:?}",
            file.contents
        );
        assert!(has_merge_guard(&file.contents));
        let plain = plan_new(
            &new_vault("Notes", false),
            &["fjord.json", ".gitattributes"],
            Some(before),
        )
        .expect("a plan");
        assert!(plain.files.iter().all(|file| file.path != ".gitattributes"));
    }

    #[test]
    fn a_gitattributes_that_was_not_read_is_never_overwritten() {
        let err = plan_new(
            &new_vault("Secret", true),
            &["fjord.json", ".gitattributes"],
            None,
        )
        .expect_err("refused");
        assert_eq!(err, VaultError::GitattributesNotRead);
        assert_eq!(err.code(), "gitattributes_not_read");
        // A plaintext vault needs no guard, so it needs no text.
        assert!(plan_new(
            &new_vault("Notes", false),
            &["fjord.json", ".gitattributes"],
            None
        )
        .is_ok());
    }

    #[test]
    fn a_name_that_is_taken_is_refused_whatever_its_case_and_whatever_holds_it() {
        for existing in [
            vec!["Notes/a.md"],
            vec!["notes"],
            vec!["NOTES/fjord.vault.json"],
            vec!["Notes.md"].into_iter().map(|_| "notes").collect(),
        ] {
            let err = plan_new(&new_vault("Notes", false), &existing, None).expect_err("refused");
            assert_eq!(err.code(), "name_taken", "{existing:?}");
        }
        assert!(plan_new(
            &new_vault("Notes", false),
            &["Notes.md", "Other/a.md"],
            None
        )
        .is_ok());
    }

    #[test]
    fn a_name_that_cannot_be_a_directory_is_refused() {
        for name in [
            "",
            ".hidden",
            "a/b",
            "a\\b",
            "con",
            "trailing.",
            "bad:name",
            "x ",
            "../up",
        ] {
            let err = plan_new(&new_vault(name, false), &["fjord.json"], None).expect_err(name);
            assert_eq!(err.code(), "invalid_name", "{name:?}: {err}");
        }
    }

    #[test]
    fn a_name_is_written_in_nfc() {
        let plan =
            plan_new(&new_vault("Cafe\u{301}", false), &["fjord.json"], None).expect("a plan");
        assert_eq!(plan.files[1].path, "Caf\u{e9}/fjord.vault.json");
    }

    #[test]
    fn recipients_and_id_naming_need_an_encrypted_vault() {
        let with_key = VaultSetup {
            recipients: vec!["age1anything".to_string()],
            ..new_vault("Notes", false)
        };
        assert_eq!(
            plan_new(&with_key, &["fjord.json"], None).expect_err("refused"),
            VaultError::RecipientsNeedEncryption
        );
        let by_id = VaultSetup {
            id_naming: true,
            ..new_vault("Notes", false)
        };
        assert_eq!(
            plan_new(&by_id, &["fjord.json"], None).expect_err("refused"),
            VaultError::IdNamingNeedsEncryption
        );
    }

    #[cfg(feature = "crypto")]
    #[test]
    fn a_recipient_that_age_cannot_use_is_refused_and_a_secret_key_is_never_echoed() {
        let secret = crate::crypto::generate_identity().secret.to_string();
        for bad in ["", "not a key", "age1short", secret.as_str()] {
            let setup = VaultSetup {
                recipients: vec![some_recipient(), bad.to_string()],
                ..new_vault("Secret", true)
            };
            let err = plan_new(&setup, &["fjord.json"], None).expect_err(bad);
            assert_eq!(err.code(), "bad_recipient", "{bad:?}");
            assert!(
                !err.to_string().contains(&secret),
                "a secret key must not appear in an error: {err}"
            );
        }
    }

    #[cfg(not(feature = "crypto"))]
    #[test]
    fn a_build_that_cannot_check_recipients_honours_none() {
        let setup = VaultSetup {
            recipients: vec!["age1anything".to_string()],
            ..new_vault("Secret", true)
        };
        assert_eq!(
            plan_new(&setup, &["fjord.json"], None).expect_err("refused"),
            VaultError::RecipientsUnsupported
        );
    }

    #[test]
    fn a_manifest_that_is_unusable_or_newer_is_not_rewritten() {
        let setup = new_vault("Notes", false);
        for bad in ["", "not json", "[]"] {
            let err = plan_vault(
                &setup,
                bad.as_bytes(),
                &["fjord.json"],
                None,
                VAULT_ID,
                VAULT_AT,
            )
            .expect_err(bad);
            assert_eq!(err.code(), "manifest_unusable", "{bad:?}");
        }
        let newer = format!("{{\"fjord\": {}, \"vaults\": []}}", FORMAT_VERSION + 1);
        let err = plan_vault(
            &setup,
            newer.as_bytes(),
            &["fjord.json"],
            None,
            VAULT_ID,
            VAULT_AT,
        )
        .expect_err("refused");
        assert_eq!(err.code(), "newer_version");
    }

    #[test]
    fn a_plan_is_pure_the_same_input_gives_the_same_plan() {
        let setup = new_vault("Notes", false);
        assert_eq!(
            plan_new(&setup, &["fjord.json"], None),
            plan_new(&setup, &["fjord.json"], None)
        );
    }

    #[cfg(feature = "native")]
    #[test]
    fn a_repository_with_a_vault_added_passes_verify_strictly() {
        use crate::verify::{verify, Options};
        for (encrypted, id_naming) in [(false, false), (true, false), (true, true)] {
            let temp = tempfile::tempdir().expect("tempdir");
            let root = temp.path();
            // A repository as `plan_setup` leaves one, then a second vault on top of it.
            let first = plan_setup(
                &setup("Public"),
                &origin(),
                &["README.md".to_string()],
                None,
            )
            .expect("a plan");
            std::fs::write(root.join("README.md"), "# Mine\n").expect("write");
            for file in &first.files {
                let path = root.join(&file.path);
                std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
                std::fs::write(&path, &file.contents).expect("write");
            }
            let manifest = std::fs::read(root.join("fjord.json")).expect("read");
            let gitattributes = std::fs::read_to_string(root.join(".gitattributes")).ok();
            let existing = ["README.md", "fjord.json", ".gitattributes", "Public"];
            let vault = VaultSetup {
                id_naming,
                recipients: if encrypted {
                    vec![some_recipient()]
                } else {
                    Vec::new()
                },
                ..new_vault("Second", encrypted)
            };
            let plan = plan_vault(
                &vault,
                &manifest,
                &existing,
                gitattributes.as_deref(),
                VAULT_ID,
                VAULT_AT,
            )
            .expect("a plan");
            for file in &plan.files {
                let path = root.join(&file.path);
                std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
                std::fs::write(&path, &file.contents).expect("write");
            }
            let report = verify(root, &Options::default()).expect("verify");
            assert_eq!(report.warnings(), 0, "strict: {:?}", report.diagnostics);
            assert_eq!(
                report.errors(),
                0,
                "encrypted={encrypted} id={id_naming}: {:?}",
                report.diagnostics
            );
            assert_eq!(report.vaults.len(), 2);
        }
    }
    #[test]
    fn encrypting_a_vault_keeps_its_id_and_every_field_it_does_not_know() {
        let manifest = br#"{"fjord":1,"id":"01jagc4k7pr9tbm3ykwx6zq2hv","name":"Notes","x-future":{"a":1},"encryption":null,"fileNaming":"plain","createdAt":"2026-10-16T09:34:00Z"}"#;
        let plan = plan_encrypt_vault(manifest, &["age1abc".to_string()]).unwrap();
        let value: serde_json::Value = serde_json::from_str(&plan.manifest).unwrap();
        assert_eq!(value["id"], "01jagc4k7pr9tbm3ykwx6zq2hv");
        assert_eq!(value["x-future"]["a"], 1);
        assert_eq!(value["encryption"]["tool"], "age");
        assert_eq!(value["encryption"]["recipients"], "recipients.txt");
        let order: Vec<&String> = value.as_object().unwrap().keys().collect();
        assert_eq!(
            order,
            [
                "fjord",
                "id",
                "name",
                "x-future",
                "encryption",
                "fileNaming",
                "createdAt"
            ]
        );
        let paths: Vec<&str> = plan.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["recipients.txt", ".gitignore"]);
        assert!(plan.files[0].contents.contains("age1abc"));
    }

    #[test]
    fn a_vault_is_encrypted_only_if_it_is_not_and_has_someone_to_write_it() {
        let encrypted = br#"{"fjord":1,"encryption":{"tool":"age"}}"#;
        assert_eq!(
            plan_encrypt_vault(encrypted, &["age1abc".to_string()]).unwrap_err(),
            ConvertError::AlreadyEncrypted
        );
        assert_eq!(
            plan_encrypt_vault(br#"{"fjord":1,"encryption":null}"#, &[]).unwrap_err(),
            ConvertError::NoRecipients
        );
        assert_eq!(
            plan_encrypt_vault(b"[]", &["age1abc".to_string()]).unwrap_err(),
            ConvertError::Unreadable
        );
    }

    #[test]
    fn decrypting_a_vault_is_the_manifest_of_a_plaintext_one() {
        let manifest = br#"{"fjord":1,"id":"X","encryption":{"tool":"age","container":"tar"},"fileNaming":"id","x":2}"#;
        let text = plan_decrypt_vault(manifest).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(value["encryption"].is_null());
        assert_eq!(value["fileNaming"], "plain");
        assert_eq!(value["x"], 2);
        assert_eq!(
            plan_decrypt_vault(&text.into_bytes()).unwrap_err(),
            ConvertError::NotEncrypted
        );
    }
    #[test]
    fn the_merge_guard_is_added_once_and_to_a_file_that_is_not_there() {
        assert_eq!(
            merge_guard_added(None).as_deref(),
            Some("*.age binary -diff -merge\n")
        );
        assert_eq!(
            merge_guard_added(Some("*.png binary")).as_deref(),
            Some("*.png binary\n*.age binary -diff -merge\n")
        );
        assert_eq!(merge_guard_added(Some("*.age binary -diff -merge\n")), None);
    }
}

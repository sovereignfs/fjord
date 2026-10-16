//! Command implementations.
//!
//! Everything here is the binary's business and never `fjord-core`'s:
//! finding the repository, deciding whether to use colour, and rendering a
//! report for a human or for CI.

pub mod crypt;
pub mod grep;
pub mod init;
pub mod keys;
pub mod list;
pub mod new;
pub mod open;
pub mod rekey;
pub mod status;
pub mod sync;
pub mod vaults;
pub mod verify;

use crate::cli::{ExitCode, GlobalArgs};
use anyhow::{Context, Result};
use fjord_core::crypto;
use owo_colors::OwoColorize;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// Resolve the repository root.
///
/// With `--repo`, the path is taken as given and **not** required to contain
/// a manifest: `fjord verify` must be able to report
/// [`Code::ManifestMissing`][c] against a directory rather than refuse to
/// look at it. Without it, the nearest ancestor holding `fjord.json` wins,
/// falling back to the current directory for the same reason.
///
/// [c]: fjord_core::diagnostics::Code::ManifestMissing
pub fn find_root(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path.to_path_buf());
    }

    let start = std::env::current_dir().context("could not read the current directory")?;
    let mut candidate = start.as_path();
    loop {
        if candidate.join(fjord_core::REPOSITORY_MANIFEST).is_file() {
            return Ok(candidate.to_path_buf());
        }
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => return Ok(start),
        }
    }
}

/// Whether to colour output, and how.
///
/// `NO_COLOR` is honoured, and so is a redirected stdout: a report piped
/// into a file or a CI log should not carry escape codes.
#[derive(Debug, Clone, Copy)]
pub struct Style {
    colour: bool,
}

impl Style {
    pub fn detect() -> Self {
        Self {
            colour: std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal(),
        }
    }

    pub fn error(self, text: &str) -> String {
        if self.colour {
            text.red().to_string()
        } else {
            text.to_string()
        }
    }

    pub fn warning(self, text: &str) -> String {
        if self.colour {
            text.yellow().to_string()
        } else {
            text.to_string()
        }
    }

    pub fn good(self, text: &str) -> String {
        if self.colour {
            text.green().to_string()
        } else {
            text.to_string()
        }
    }

    pub fn dim(self, text: &str) -> String {
        if self.colour {
            text.dimmed().to_string()
        } else {
            text.to_string()
        }
    }
}

/// What came of trying to read a document.
#[derive(Debug)]
pub enum DocumentRead {
    Text {
        /// The document's real name, when a tar container carried one
        /// (§6.4). In an `id` vault this is the only place the name
        /// exists, since the leaf on disk is the identifier.
        name: Option<String>,
        bytes: Zeroizing<Vec<u8>>,
    },
    /// An encrypted payload, and no identity of ours opens it. Normal on a
    /// vault shared with other people.
    NeedsIdentity,
    Failed(String),
}

/// Read a vault file, decrypting it if it is a payload.
///
/// Decrypted content is returned in a [`Zeroizing`] buffer and never
/// written anywhere: `ls` and `grep` look at documents without leaving a
/// copy behind.
pub fn read_document(
    vault: &fjord_core::vault::Vault,
    path: &Path,
    identities: Option<&crypto::Identities>,
) -> DocumentRead {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) => return DocumentRead::Failed(err.to_string()),
    };

    match fjord_core::store::load(vault, &bytes, identities) {
        Ok(loaded) => DocumentRead::Text {
            name: loaded.name,
            bytes: loaded.plaintext,
        },
        Err(fjord_core::store::Error::NeedsIdentity) => DocumentRead::NeedsIdentity,
        Err(fjord_core::store::Error::Crypto(_)) => DocumentRead::NeedsIdentity,
        // A malformed container is E303, and it can only surface here: the
        // archive is inside the ciphertext, so `fjord verify` never sees
        // it.
        Err(err) => DocumentRead::Failed(format!(
            "{} ({})",
            err,
            fjord_core::diagnostics::Code::MalformedContainer.as_str()
        )),
    }
}

/// Refuse to write to a repository made by a newer Fjord.
///
/// Invariant 4 and spec §10.1: a client encountering a `fjord` version
/// greater than the one it implements MUST NOT write, MAY read, and SHOULD
/// say so. Returns the exit code to use when writing must be refused.
pub fn ensure_writable(root: &Path) -> Result<Option<ExitCode>> {
    let path = root.join(fjord_core::REPOSITORY_MANIFEST);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        // No manifest at all is not this function's problem to report.
        Err(_) => return Ok(None),
    };
    let manifest = match fjord_core::manifest::Manifest::parse(&bytes) {
        Ok(manifest) => manifest,
        Err(_) => return Ok(None),
    };

    match manifest.version() {
        Some(version) if version > i64::from(fjord_core::FORMAT_VERSION) => {
            Ok(Some(usage(format!(
                "this repository declares Fjord format version {version}, and this build \
                 implements {}. Reading it is fine; writing to it is not, because a newer \
                 version may store things this build would silently destroy. Upgrade fjord.",
                fjord_core::FORMAT_VERSION
            ))))
        }
        _ => Ok(None),
    }
}

/// Where Fjord keeps files that are not part of a repository.
///
/// `$FJORD_CONFIG_DIR`, else `$HOME/.config/fjord`. No `dirs` crate: one
/// environment variable and a documented fallback is less to explain, and
/// an identity's location is something a user needs to be able to predict.
pub fn config_dir() -> Result<PathBuf> {
    if let Some(configured) = std::env::var_os("FJORD_CONFIG_DIR") {
        return Ok(PathBuf::from(configured));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .context(
            "neither FJORD_CONFIG_DIR nor HOME is set, so there is nowhere to look for an identity",
        )?;
    Ok(PathBuf::from(home).join(".config").join("fjord"))
}

/// Where `fjord key new` writes an identity, and where every command looks
/// for one when `--identity` is not given.
pub fn default_identity_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("identity.txt"))
}

/// The Fjord repository containing `path`, if any — including a path that
/// does not exist yet, so that a destination can be judged before it is
/// written.
pub fn enclosing_repository(path: &Path) -> Option<PathBuf> {
    let absolute = std::path::absolute(path).ok()?;
    let mut candidate = absolute.parent();
    while let Some(directory) = candidate {
        if directory.join(fjord_core::REPOSITORY_MANIFEST).is_file() {
            return Some(directory.to_path_buf());
        }
        candidate = directory.parent();
    }
    None
}

/// Load the identities a command may decrypt with. Spec §11.3.
///
/// `--identity -` reads from stdin, so a secret can arrive from a password
/// manager or a keyring without ever touching the filesystem — and never
/// through `argv`, which every process on the machine can read.
pub fn load_identities(global: &GlobalArgs) -> Result<crypto::Identities> {
    let (label, text) = match global.identity.as_deref() {
        Some(path) if path == Path::new("-") => {
            let mut text = Zeroizing::new(String::new());
            std::io::stdin()
                .read_to_string(&mut text)
                .context("could not read an identity from stdin")?;
            ("stdin".to_string(), text)
        }
        Some(path) => (path.display().to_string(), read_identity(path)?),
        None => {
            let path = default_identity_path()?;
            if !path.is_file() {
                anyhow::bail!(
                    "no identity found. Generate one with `fjord key new`, or point to \
                     an existing one with --identity <path> (or $FJORD_IDENTITY). \
                     Looked in {}",
                    path.display()
                );
            }
            (path.display().to_string(), read_identity(&path)?)
        }
    };

    crypto::parse_identities(&text).with_context(|| format!("{label} is not a usable identity"))
}

fn read_identity(path: &Path) -> Result<Zeroizing<String>> {
    let bytes = Zeroizing::new(
        std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?,
    );

    // age warns about this and so should we: an identity other users can
    // read is already compromised.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(metadata) = std::fs::metadata(path) {
            if metadata.mode() & 0o077 != 0 {
                eprintln!(
                    "warning: {} is readable by other users (mode {:o})",
                    path.display(),
                    metadata.mode() & 0o777
                );
            }
        }
    }

    Ok(Zeroizing::new(String::from_utf8_lossy(&bytes).to_string()))
}

/// Resolve `path` as far as the filesystem allows, including paths that do
/// not exist yet.
///
/// `std::path::absolute` only prepends the working directory: it does not
/// resolve symbolic links, so on a system where an ancestor is a link —
/// `/var` on macOS, a symlinked home directory — an absolute path can point
/// at a repository while comparing unequal to it. A guard built on that
/// comparison fails *open*, which for invariant 1 is the worst direction to
/// fail in.
///
/// So the deepest existing ancestor is canonicalised and the remaining
/// components re-appended.
pub fn resolve_destination(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());

    let mut remainder: Vec<std::ffi::OsString> = Vec::new();
    let mut candidate = absolute.as_path();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(candidate) {
            let mut resolved = canonical;
            for component in remainder.iter().rev() {
                resolved.push(component);
            }
            return resolved;
        }
        match (candidate.file_name(), candidate.parent()) {
            (Some(name), Some(parent)) => {
                remainder.push(name.to_os_string());
                candidate = parent;
            }
            // Nothing above exists to canonicalise against.
            _ => return absolute,
        }
    }
}

/// Turn a path a user typed into a repository-relative one.
///
/// Two spellings are accepted, in this order:
///
/// 1. **As given** — absolute, or relative to the working directory, so
///    that shell completion and `./notes.md` work from wherever the user
///    happens to be.
/// 2. **Relative to the repository root**, which is what `--help` promises
///    and what `-C` users need: `fjord -C ~/notes open Private/notes.md`
///    must mean the document in that repository, not one beside the
///    terminal's working directory.
///
/// Returns the *message* for an unusable path rather than printing one:
/// callers probe several spellings, and a lookup that fails on the way to a
/// success must not leave an error on stderr. Printing is the caller's job,
/// through [`usage`].
pub fn repo_relative(root: &Path, input: &Path) -> Result<std::result::Result<String, String>> {
    let canonical_root = std::fs::canonicalize(root)
        .with_context(|| format!("could not resolve {}", root.display()))?;

    for candidate in [input.to_path_buf(), canonical_root.join(input)] {
        let absolute = match std::fs::canonicalize(&candidate) {
            Ok(absolute) => absolute,
            Err(_) => continue,
        };
        return match absolute.strip_prefix(&canonical_root) {
            Ok(relative) => Ok(Ok(relative.to_string_lossy().replace('\\', "/"))),
            Err(_) => Ok(Err(format!(
                "{} is outside the repository at {}",
                input.display(),
                canonical_root.display()
            ))),
        };
    }

    Ok(Err(format!("{} does not exist", input.display())))
}

/// Report a problem with how the command was invoked, and the exit code
/// that goes with it.
///
/// A usage error is exit 2, distinct from the 3 an IO or git failure gets,
/// so a script can tell "you asked for something impossible" from "the
/// machine would not cooperate".
pub fn usage(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("error: {message}");
    ExitCode::Usage
}

/// `1 doc`, `2 docs`.
pub fn plural(count: usize, singular: &str, plural: &str) -> String {
    if count == 1 {
        format!("{count} {singular}")
    } else {
        format!("{count} {plural}")
    }
}

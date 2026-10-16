//! The Fjord repository format.
//!
//! This crate implements the format described in `spec/SPEC.md`: manifests,
//! documents, path rules, `age` encryption, and the conformance checks that
//! back `fjord verify`.
//!
//! # Portability
//!
//! This crate is compiled into the CLI, the Tauri desktop app, the mobile
//! clients via FFI, and the web client via WASM. It therefore must never
//! depend on:
//!
//! - a subprocess — no `std::process::Command`, for anything, ever;
//! - a terminal — no printing, no colour, no progress reporting; return data
//!   and let the caller render it;
//! - git — that belongs to the binary.
//!
//! Filesystem access is confined to the few functions that genuinely need
//! it, so a virtual filesystem can be substituted for WASM later.
//!
//! # Invariants
//!
//! See `CLAUDE.md` for the full list. The two that shape most of this crate:
//! plaintext never enters an encrypted vault, and unknown fields survive a
//! round trip.

#![forbid(unsafe_code)]
#![warn(missing_debug_implementations)]

pub mod crypto;
pub mod diagnostics;
pub mod doc;
pub mod manifest;
pub mod path;
pub mod scaffold;
pub mod scalar;
pub mod vault;
pub mod verify;

// Still to come; see CLAUDE.md § Milestones.
//
// pub mod container;   // tar container for fileNaming "id"     — M7

/// The format version this build implements.
///
/// A repository declaring a higher version is read-only: see
/// [`diagnostics::Code::UnsupportedVersion`] and spec §10.1.
pub const FORMAT_VERSION: u32 = 1;

/// The repository manifest, at the root. Spec §3.
pub const REPOSITORY_MANIFEST: &str = "fjord.json";

/// The vault manifest. A directory is a vault if and only if it contains
/// one. Spec §2.1.
pub const VAULT_MANIFEST: &str = "fjord.vault.json";

/// Reserved for client machinery at the repository root. Its contents MUST
/// be ignored and preserved. Spec §2.2, §12.
pub const RESERVED_DIRECTORY: &str = ".fjord";

/// Files and directories reserved by the format. Spec §2.2.
pub const RESERVED_NAMES: &[&str] = &[REPOSITORY_MANIFEST, VAULT_MANIFEST, RESERVED_DIRECTORY];

/// Size above which a file earns [`diagnostics::Code::FileTooLarge`].
///
/// Advisory only. Fjord warns; it never refuses. Spec §1.1.
pub const LARGE_FILE_WARN_BYTES: u64 = 25 * 1024 * 1024;

/// Path length above which Windows checkout may fail. Spec §5.
pub const LONG_PATH_WARN_BYTES: usize = 240;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_version_matches_the_spec() {
        assert_eq!(FORMAT_VERSION, 1);
    }

    #[test]
    fn reserved_names_are_the_ones_the_spec_reserves() {
        assert!(RESERVED_NAMES.contains(&REPOSITORY_MANIFEST));
        assert!(RESERVED_NAMES.contains(&VAULT_MANIFEST));
        assert!(RESERVED_NAMES.contains(&RESERVED_DIRECTORY));
    }
}

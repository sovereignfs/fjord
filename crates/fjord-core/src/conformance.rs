// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The conformance levels this build declares. Spec §10.
//!
//! §10 says a client declares one or more levels and MUST NOT perform an
//! operation above them. The declaration is [`DECLARED`], here in the core
//! so that the desktop, mobile and web clients built on this crate read the
//! same fact rather than each restating it; the CLI publishes it in
//! `fjord verify --json`.
//!
//! # What backs each claim
//!
//! | Level | Where the requirement is met |
//! | --- | --- |
//! | L0 | [`crate::verify`], [`crate::manifest`], [`crate::doc`], [`crate::vault`] |
//! | L1 | [`crate::scalar::new_ulid`], [`crate::doc`] (unknown keys kept), [`crate::path`], [`crate::repair`] |
//! | L2 | [`crate::crypto`], [`crate::container`], [`crate::store`] |
//! | L3 | [`crate::store`] (never plaintext into an encrypted vault; no recipients is a refusal), `fjord sync` (merge by decrypting) |
//!
//! # The one thing L3 does not cover
//!
//! §6.2 says an encrypted file MUST go to *all* listed recipients, and also
//! that SSH recipients MAY appear. This build does not link an RSA
//! implementation (RUSTSEC-2023-0071), so it cannot write to a vault that
//! lists one. It **refuses** such a write by name rather than encrypting to
//! the recipients it can handle, which is what keeps the declaration true:
//! every file it does write goes to all of them. On such a vault it is an
//! L2 client. See [`crate::crypto`].

use std::fmt;

/// A conformance level. Spec §10.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Plaintext reader.
    L0,
    /// Plaintext writer.
    L1,
    /// Encrypted reader.
    L2,
    /// Encrypted writer.
    L3,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::L0 => "L0",
            Level::L1 => "L1",
            Level::L2 => "L2",
            Level::L3 => "L3",
        }
    }

    /// The levels §10 builds this one from. L1 and L2 each include L0; L3
    /// is "L1 + L2".
    pub fn requires(self) -> &'static [Level] {
        match self {
            Level::L0 => &[],
            Level::L1 | Level::L2 => &[Level::L0],
            Level::L3 => &[Level::L1, Level::L2],
        }
    }
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The levels this build declares, in order.
pub const DECLARED: &[Level] = &[Level::L0, Level::L1, Level::L2, Level::L3];

/// Whether this build may perform an operation that needs `level`.
pub fn permits(level: Level) -> bool {
    DECLARED.contains(&level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declared_level_declares_the_levels_it_is_built_from() {
        // §10 defines L3 as "L1 + L2" and L1 and L2 as "L0, plus": claiming
        // a level while denying a part of it would contradict the spec.
        for level in DECLARED {
            for needed in level.requires() {
                assert!(permits(*needed), "{level} requires {needed}");
            }
        }
    }

    #[test]
    fn the_names_are_the_specs() {
        let names: Vec<_> = DECLARED.iter().map(|level| level.as_str()).collect();
        assert_eq!(names, ["L0", "L1", "L2", "L3"]);
    }
}

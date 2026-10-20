// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Repairing `fjord.json` where it disagrees with the disk. Spec §2.1, §10.
//!
//! §2.1 makes the filesystem authoritative and says clients SHOULD repair
//! the manifest; conformance level L1 (§10) makes that part of being a
//! plaintext writer. Invariant 6 in `CLAUDE.md` is the same rule from the
//! other side: a file absent from a manifest is never quarantined, renamed
//! or deleted — the manifest is what changes.
//!
//! This is the whole of what the repair does, and `fjord verify --fix`
//! applies nothing else:
//!
//! - **a vault on disk that `fjord.json` does not list**
//!   ([`Code::VaultNotInManifest`]) is added, with the `id` its own
//!   `fjord.vault.json` declares;
//! - **a listed vault with no `fjord.vault.json` on disk**
//!   ([`Code::VaultNotOnDisk`]) has its entry removed.
//!
//! It is deliberately conservative about what it will not guess. A vault
//! whose own `id` is missing, malformed or already listed under another path
//! is left for a human, because writing it would turn a warning into an
//! error. Everything else in `fjord.json` — unknown keys, key order, other
//! entries and the fields on them — is carried through untouched
//! (§10.1, invariant 3).
//!
//! Nothing here writes: [`plan_manifest`] returns the new text and the
//! caller decides whether to put it on disk.

use crate::diagnostics::Code;
use crate::manifest::{field, Manifest};
use crate::verify::Report;
use crate::{scalar, VAULT_MANIFEST};
use serde_json::Value;
use std::path::Path;

/// One change made to the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Repair {
    /// A vault found on disk was added to the manifest.
    Added { path: String },
    /// An entry for a vault that is not on disk was removed.
    Removed { path: String },
}

impl Repair {
    pub fn path(&self) -> &str {
        match self {
            Repair::Added { path } | Repair::Removed { path } => path,
        }
    }

    /// A stable word for output: `"added"` or `"removed"`.
    pub fn action(&self) -> &'static str {
        match self {
            Repair::Added { .. } => "added",
            Repair::Removed { .. } => "removed",
        }
    }
}

/// A repaired manifest, and what changed to produce it.
#[derive(Debug, Clone)]
pub struct Plan {
    /// The complete new `fjord.json`.
    pub text: String,
    pub repairs: Vec<Repair>,
}

/// Work out the manifest repairs `report` calls for. Returns `None` when
/// there is nothing to do, or when the manifest is not in a state this can
/// safely edit (`vaults` absent or not an array).
///
/// `root` is only read, to find an unlisted vault's `id`.
pub fn plan_manifest(root: &Path, manifest: &Manifest, report: &Report) -> Option<Plan> {
    let mut raw = manifest.raw().clone();
    let mut entries = match raw.get(field::VAULTS) {
        Some(Value::Array(entries)) => entries.clone(),
        _ => return None,
    };

    let mut repairs = Vec::new();

    for diagnostic in &report.diagnostics {
        if diagnostic.code != Code::VaultNotOnDisk || !diagnostic.code.is_auto_fixable() {
            continue;
        }
        let Some(path) = diagnostic.path.as_deref() else {
            continue;
        };
        let before = entries.len();
        entries.retain(|entry| entry.get(field::PATH).and_then(Value::as_str) != Some(path));
        if entries.len() != before {
            repairs.push(Repair::Removed {
                path: path.to_string(),
            });
        }
    }

    let mut listed_ids: Vec<String> = entries
        .iter()
        .filter_map(|entry| entry.get(field::ID).and_then(Value::as_str))
        .map(String::from)
        .collect();

    for diagnostic in &report.diagnostics {
        if diagnostic.code != Code::VaultNotInManifest || !diagnostic.code.is_auto_fixable() {
            continue;
        }
        let Some(path) = diagnostic.path.as_deref() else {
            continue;
        };
        let Some(id) = vault_id(root, path) else {
            continue;
        };
        if listed_ids.contains(&id) {
            continue;
        }
        listed_ids.push(id.clone());
        entries.push(serde_json::json!({ field::PATH: path, field::ID: id }));
        repairs.push(Repair::Added {
            path: path.to_string(),
        });
    }

    if repairs.is_empty() {
        return None;
    }

    raw.insert(field::VAULTS.to_string(), Value::Array(entries));
    Some(Plan {
        text: crate::scaffold::pretty(&Value::Object(raw)),
        repairs,
    })
}

/// The `id` a vault's own manifest declares, if it is a usable one.
fn vault_id(root: &Path, relative: &str) -> Option<String> {
    let bytes = std::fs::read(root.join(relative).join(VAULT_MANIFEST)).ok()?;
    let manifest = Manifest::parse(&bytes).ok()?;
    let id = manifest.string(field::ID)?;
    scalar::is_ulid(id).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify::{verify, Options};

    const ID_A: &str = "01jb8x4k7m2n3p5q6r9s0t1v2w";
    const ID_B: &str = "01jb8x4k7m2n3p5q6r9s0t1v3x";

    fn write(root: &Path, path: &str, text: &str) {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().expect("parent")).expect("mkdir");
        std::fs::write(full, text).expect("write");
    }

    fn vault(root: &Path, name: &str, id: &str) {
        write(
            root,
            &format!("{name}/fjord.vault.json"),
            &format!(
                "{{\"fjord\":1,\"id\":\"{id}\",\"name\":\"{name}\",\"createdAt\":\"2026-01-01T00:00:00Z\",\"encryption\":null,\"fileNaming\":\"plain\"}}"
            ),
        );
    }

    fn plan_for(root: &Path) -> Option<Plan> {
        let text = std::fs::read(root.join("fjord.json")).expect("read");
        let manifest = Manifest::parse(&text).expect("parse");
        let report = verify(root, &Options::default()).expect("verify");
        plan_manifest(root, &manifest, &report)
    }

    fn repository(vaults: &str, extra: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            "fjord.json",
            &format!(
                "{{\"fjord\":1,\"id\":\"01jb8x4k7m2n3p5q6r9s0t1v1v\",\"name\":\"r\",\"createdAt\":\"2026-01-01T00:00:00Z\",{extra}\"vaults\":[{vaults}]}}"
            ),
        );
        dir
    }

    #[test]
    fn the_allowlist_is_exactly_what_this_module_repairs() {
        // Adding a code to `is_auto_fixable` without teaching this module
        // (or the reverse) would make `--fix` promise something it does not
        // do, or do something it never promised.
        let fixable: Vec<_> = Code::all()
            .iter()
            .copied()
            .filter(|code| code.is_auto_fixable())
            .collect();
        assert_eq!(fixable, [Code::VaultNotOnDisk, Code::VaultNotInManifest]);
    }

    #[test]
    fn nothing_to_repair_is_none() {
        let dir = repository(&format!("{{\"path\":\"A\",\"id\":\"{ID_A}\"}}"), "");
        vault(dir.path(), "A", ID_A);
        assert!(plan_for(dir.path()).is_none());
    }

    #[test]
    fn an_unlisted_vault_is_added_with_its_own_id() {
        let dir = repository("", "");
        vault(dir.path(), "A", ID_A);
        let plan = plan_for(dir.path()).expect("plan");
        assert_eq!(
            plan.repairs,
            vec![Repair::Added {
                path: "A".to_string()
            }]
        );
        assert!(plan.text.contains(ID_A), "{}", plan.text);
    }

    #[test]
    fn a_listed_vault_that_is_gone_is_removed_and_the_rest_survive() {
        let dir = repository(
            &format!(
                "{{\"path\":\"A\",\"id\":\"{ID_A}\"}},{{\"path\":\"B\",\"id\":\"{ID_B}\",\"future\":true}}"
            ),
            "",
        );
        vault(dir.path(), "B", ID_B);
        let plan = plan_for(dir.path()).expect("plan");
        assert_eq!(
            plan.repairs,
            vec![Repair::Removed {
                path: "A".to_string()
            }]
        );
        // The surviving entry keeps a field this build does not know.
        assert!(plan.text.contains("\"future\": true"), "{}", plan.text);
        assert!(!plan.text.contains(ID_A), "{}", plan.text);
    }

    #[test]
    fn unknown_manifest_keys_and_their_order_are_preserved() {
        let dir = repository("", "\"zeta\":1,\"alpha\":{\"n\":2},");
        vault(dir.path(), "A", ID_A);
        let plan = plan_for(dir.path()).expect("plan");
        let zeta = plan.text.find("\"zeta\"").expect("zeta");
        let alpha = plan.text.find("\"alpha\"").expect("alpha");
        assert!(zeta < alpha, "{}", plan.text);
    }

    #[test]
    fn a_vault_without_a_usable_id_is_left_for_a_human() {
        let dir = repository("", "");
        vault(dir.path(), "A", "NOT-A-ULID");
        assert!(plan_for(dir.path()).is_none());
    }

    #[test]
    fn a_vault_whose_id_is_already_listed_is_not_added_twice() {
        let dir = repository(&format!("{{\"path\":\"A\",\"id\":\"{ID_A}\"}}"), "");
        vault(dir.path(), "A", ID_A);
        vault(dir.path(), "Copy", ID_A);
        assert!(plan_for(dir.path()).is_none());
    }

    #[test]
    fn a_repaired_manifest_no_longer_disagrees_with_the_disk() {
        let dir = repository(&format!("{{\"path\":\"Gone\",\"id\":\"{ID_B}\"}}"), "");
        vault(dir.path(), "A", ID_A);
        let plan = plan_for(dir.path()).expect("plan");
        std::fs::write(dir.path().join("fjord.json"), plan.text).expect("write");
        let report = verify(dir.path(), &Options::default()).expect("verify");
        let codes: Vec<_> = report.diagnostics.iter().map(|d| d.code).collect();
        assert!(
            !codes.contains(&Code::VaultNotOnDisk) && !codes.contains(&Code::VaultNotInManifest),
            "{codes:?}"
        );
    }
}

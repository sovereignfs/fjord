// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A listing and the filesystem walk must say the same about every fixture (ROADMAP P3).
//!
//! `tests/fixtures/discovery.json` is what the filesystem walk said about each committed fixture
//! (which vaults, which files in them and what each is, which manifests are nested, what `verify`
//! counted) **before** discovery was moved onto [`fjord_core::listing`]. Three things are held to it:
//! the pure function over a bare list of paths, the CLI's own filesystem API, and `verify`. If any of
//! them disagrees, a client built on one would see a different repository from a client built on
//! another.

use fjord_core::listing::{self, FileKind, ListedFile};
use fjord_core::verify::{verify, Options};
use fjord_core::{vault, VAULT_MANIFEST};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn golden() -> BTreeMap<String, Value> {
    let text = std::fs::read_to_string(fixtures().join("discovery.json")).expect("discovery.json");
    serde_json::from_str(&text).expect("valid JSON")
}

fn root_of(name: &str) -> PathBuf {
    fixtures().join(name)
}

/// Every file under `root`, as a client with only a listing would have it: no directories, links as
/// files, nothing read.
fn walk(root: &Path, dir: &Path, out: &mut Vec<ListedFile>) {
    for entry in std::fs::read_dir(dir).expect("read_dir") {
        let entry = entry.expect("entry");
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).expect("metadata");
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            walk(root, &path, out);
        } else {
            let relative = path
                .strip_prefix(root)
                .expect("inside")
                .to_string_lossy()
                .replace('\\', "/");
            out.push(ListedFile {
                path: relative,
                size: metadata.len(),
            });
        }
    }
}

fn listing_of(name: &str) -> Vec<ListedFile> {
    let root = root_of(name);
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out
}

fn manifests_of(name: &str, files: &[ListedFile]) -> BTreeMap<String, Vec<u8>> {
    listing::manifest_paths(files)
        .into_iter()
        .filter_map(|path| {
            std::fs::read(root_of(name).join(&path))
                .ok()
                .map(|bytes| (path, bytes))
        })
        .collect()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|v| v.as_str().expect("string").to_string())
        .collect()
}

#[test]
fn the_golden_file_covers_every_committed_fixture() {
    let mut expected = vec!["conforming".to_string()];
    for entry in std::fs::read_dir(fixtures().join("broken")).expect("broken") {
        expected.push(format!(
            "broken/{}",
            entry.expect("entry").file_name().to_string_lossy()
        ));
    }
    expected.sort();
    let mut have: Vec<String> = golden().keys().cloned().collect();
    have.sort();
    assert_eq!(
        have, expected,
        "add a fixture to discovery.json (or remove it) so the two stay in step"
    );
}

/// The pure function, given nothing but paths, sizes and the manifests' bytes.
#[test]
fn a_listing_says_what_the_filesystem_walk_said() {
    for (name, expected) in golden() {
        let files = listing_of(&name);
        let found = listing::discover(&files, &manifests_of(&name, &files));

        assert_eq!(
            found.nested,
            strings(&expected["verify"]["nested"]),
            "{name}: nested vault manifests"
        );

        // A fixture whose vault manifest cannot be read made the filesystem API fail as a whole;
        // from a listing the same vault is listed, with its problem.
        let Some(vaults) = expected["discover"].as_array() else {
            assert!(
                found.vaults.iter().any(|v| v.manifest.is_err()),
                "{name}: the unreadable manifest is reported"
            );
            continue;
        };

        let directories: Vec<&str> = found.vaults.iter().map(|v| v.directory.as_str()).collect();
        let wanted: Vec<&str> = vaults
            .iter()
            .map(|v| v["directory"].as_str().expect("directory"))
            .collect();
        assert_eq!(directories, wanted, "{name}: which directories are vaults");

        for (vault, expected) in found.vaults.iter().zip(vaults) {
            let at = format!("{name}/{}", vault.directory);
            let manifest = vault
                .manifest
                .as_ref()
                .unwrap_or_else(|err| panic!("{at}: {err}"));
            let settings = vault.settings.as_ref().expect("settings");
            assert_eq!(
                manifest.string("name"),
                expected["label"].as_str(),
                "{at}: label"
            );
            assert_eq!(
                settings.encrypted,
                expected["encrypted"].as_bool().expect("bool"),
                "{at}: encrypted"
            );
            assert_eq!(
                settings.suffix,
                expected["suffix"].as_str().expect("suffix"),
                "{at}: suffix"
            );
            assert_eq!(
                settings.machinery,
                strings(&expected["machinery"]),
                "{at}: machinery"
            );

            let contents = expected["contents"].as_array().expect("contents");
            assert_eq!(vault.files.len(), contents.len(), "{at}: how many files");
            for (file, expected) in vault.files.iter().zip(contents) {
                assert_eq!(
                    file.relative,
                    expected["relative"].as_str().expect("relative"),
                    "{at}"
                );
                assert_eq!(
                    file.logical,
                    expected["logical"].as_str().expect("logical"),
                    "{at}/{}",
                    file.relative
                );
                assert_eq!(
                    file.kind == FileKind::Payload,
                    expected["is_payload"].as_bool().expect("bool"),
                    "{at}/{}",
                    file.relative
                );
                assert_eq!(
                    file.size,
                    expected["size"].as_u64().expect("size"),
                    "{at}/{}",
                    file.relative
                );
            }
        }
    }
}

/// The CLI's own API, which walks the filesystem and asks the same function.
#[test]
fn the_filesystem_api_says_what_it_said_before() {
    for (name, expected) in golden() {
        let root = root_of(&name);
        let Some(vaults) = expected["discover"].as_array() else {
            assert!(
                vault::discover(&root).is_err(),
                "{name}: an unreadable manifest is still an error here"
            );
            continue;
        };
        let found = vault::discover(&root).unwrap_or_else(|err| panic!("{name}: {err}"));
        assert_eq!(found.len(), vaults.len(), "{name}");
        for (vault, expected) in found.iter().zip(vaults) {
            let at = format!("{name}/{}", vault.directory);
            assert_eq!(
                vault.directory,
                expected["directory"].as_str().expect("directory"),
                "{at}"
            );
            assert_eq!(vault.label(), expected["label"].as_str(), "{at}");
            assert_eq!(
                vault.is_encrypted(),
                expected["encrypted"].as_bool().expect("bool"),
                "{at}"
            );
            assert_eq!(
                vault.suffix(),
                expected["suffix"].as_str().expect("suffix"),
                "{at}"
            );
            assert_eq!(vault.machinery(), strings(&expected["machinery"]), "{at}");
            let contents = vault.contents().expect("contents");
            let wanted = expected["contents"].as_array().expect("contents");
            assert_eq!(contents.len(), wanted.len(), "{at}: how many files");
            for (content, expected) in contents.iter().zip(wanted) {
                assert_eq!(
                    content.relative,
                    expected["relative"].as_str().expect("relative"),
                    "{at}"
                );
                assert_eq!(
                    content.logical,
                    expected["logical"].as_str().expect("logical"),
                    "{at}"
                );
                assert_eq!(
                    content.is_payload,
                    expected["is_payload"].as_bool().expect("bool"),
                    "{at}"
                );
                assert_eq!(
                    content.size,
                    expected["size"].as_u64().expect("size"),
                    "{at}"
                );
            }
        }
    }
}

/// And `verify`, whose own walk now locates and classifies through the same function.
#[test]
fn verify_counts_and_nests_what_it_did_before() {
    for (name, expected) in golden() {
        let report = verify(&root_of(&name), &Options::default()).expect("verify");
        let nested: Vec<String> = report
            .diagnostics
            .iter()
            .filter(|d| d.code.as_str() == "E207")
            .map(|d| d.path.clone().unwrap_or_default())
            .collect();
        assert_eq!(
            nested,
            strings(&expected["verify"]["nested"]),
            "{name}: nested vaults"
        );

        let wanted = expected["verify"]["vaults"].as_array().expect("vaults");
        assert_eq!(report.vaults.len(), wanted.len(), "{name}: vaults");
        for (summary, expected) in report.vaults.iter().zip(wanted) {
            assert_eq!(
                summary.path,
                expected["path"].as_str().expect("path"),
                "{name}"
            );
            assert_eq!(
                summary.docs as u64,
                expected["docs"].as_u64().expect("docs"),
                "{name}/{}: docs",
                summary.path
            );
            assert_eq!(
                summary.files as u64,
                expected["files"].as_u64().expect("files"),
                "{name}/{}: files",
                summary.path
            );
        }
    }
}

#[test]
fn the_vault_manifest_constant_is_what_the_listing_looks_for() {
    assert_eq!(
        listing::vault_manifest_at(&format!("V/{VAULT_MANIFEST}")),
        listing::ManifestAt::Vault("V".to_string())
    );
}

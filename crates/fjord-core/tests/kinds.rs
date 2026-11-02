// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#![cfg(feature = "native")]
// These write a repository to a disk and verify it, which the pure subset has no part in.

//! Every kind's scaffold, written and verified. Spec §3.1.

use fjord_core::manifest::{Engine, Kind, Manifest};
use fjord_core::scaffold::{self, KindChoice, KindSettings, Origin, SiteEngine};
use fjord_core::verify::{self, Options};

fn origin() -> Origin {
    let random: Vec<u8> = (0..Origin::ENTROPY_BYTES as u8)
        .map(|i| i.wrapping_mul(11).wrapping_add(5))
        .collect();
    Origin::from_entropy(1_793_559_600_000, &random).expect("an origin")
}

fn settings(kind: KindChoice) -> KindSettings {
    KindSettings {
        name: "A \"quoted\": name".to_string(),
        generator: "fjord test".to_string(),
        kind,
    }
}

/// Write the plan and verify it: the codes it emits, and its manifest.
fn made(kind: KindChoice) -> (tempfile::TempDir, Vec<String>, Manifest) {
    let temp = tempfile::tempdir().expect("temporary directory");
    let plan = scaffold::plan_kind_with(&settings(kind), &origin());
    scaffold::write(temp.path(), &plan).expect("write");
    let report = verify::verify(temp.path(), &Options::default()).expect("verify");
    let codes = report
        .diagnostics
        .iter()
        .map(|d| d.code.as_str().to_string())
        .collect();
    let manifest = Manifest::parse(&std::fs::read(temp.path().join("fjord.json")).expect("read"))
        .expect("parse");
    (temp, codes, manifest)
}

#[test]
fn a_drive_is_today_s_repository_byte_for_byte() {
    for encrypt_private in [false, true] {
        let kind =
            scaffold::plan_kind_with(&settings(KindChoice::Drive { encrypt_private }), &origin());
        let before = scaffold::plan_with(
            &scaffold::Settings {
                name: "A \"quoted\": name".to_string(),
                encrypt_private,
                generator: "fjord test".to_string(),
            },
            &origin(),
        );
        let pairs = |plan: &scaffold::Plan| {
            plan.files
                .iter()
                .map(|f| (f.path.clone(), f.contents.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(pairs(&kind), pairs(&before));
    }
    let (_temp, _codes, manifest) = made(KindChoice::Drive {
        encrypt_private: false,
    });
    assert!(!manifest.has("kind"), "a drive writes no kind");
}

#[test]
fn a_plaintext_journal_verifies_with_one_vault() {
    let (temp, codes, manifest) = made(KindChoice::Journal { encrypted: false });
    assert_eq!(codes, Vec::<String>::new());
    assert_eq!(manifest.presented_kind(), Kind::Journal);
    let vault = Manifest::parse(
        &std::fs::read(temp.path().join("journal/fjord.vault.json")).expect("read"),
    )
    .expect("parse");
    assert!(!vault.is_encrypted());
    assert_eq!(vault.file_naming(), Some("plain"));
}

#[test]
fn an_encrypted_journal_names_by_id_and_waits_for_a_key() {
    // Encrypted with no recipients yet, as `Private` is in a new drive: valid, and unwritable until the
    // owner adds a key (§6.2), which is the warning W602 and nothing else.
    let (temp, codes, manifest) = made(KindChoice::Journal { encrypted: true });
    assert_eq!(codes, vec!["W602"]);
    assert_eq!(manifest.presented_kind(), Kind::Journal);
    let vault = Manifest::parse(
        &std::fs::read(temp.path().join("journal/fjord.vault.json")).expect("read"),
    )
    .expect("parse");
    assert!(vault.is_encrypted());
    assert_eq!(vault.file_naming(), Some("id"));
    assert!(temp.path().join("journal/.gitignore").is_file());
}

#[test]
fn each_engine_s_site_verifies_with_its_files_outside_the_vault() {
    for (engine, kept, post) in [
        (
            SiteEngine::Astro,
            "src/content.config.ts",
            "content/posts/welcome.md",
        ),
        (
            SiteEngine::Jekyll,
            "_config.yml",
            "content/_posts/2026-11-01-welcome.md",
        ),
    ] {
        let (temp, codes, manifest) = made(KindChoice::Ssg { engine });
        assert_eq!(codes, Vec::<String>::new(), "{engine:?}");
        assert_eq!(manifest.presented_kind(), Kind::Ssg);
        assert_eq!(manifest.ssg_engine(), Some(Engine::parse(engine.as_str())));
        assert!(temp.path().join(kept).is_file(), "{engine:?}: {kept}");
        assert!(temp.path().join(post).is_file(), "{engine:?}: {post}");
    }
}

#[test]
fn a_site_s_name_cannot_break_its_configuration() {
    let plan = scaffold::plan_kind_with(
        &settings(KindChoice::Ssg {
            engine: SiteEngine::Jekyll,
        }),
        &origin(),
    );
    let config = plan
        .files
        .iter()
        .find(|f| f.path == "_config.yml")
        .expect("config");
    let title = config
        .contents
        .lines()
        .find(|line| line.starts_with("title: "))
        .expect("title");
    let fjord_core::yaml::Read::Mapping(parsed) =
        fjord_core::yaml::read_mapping(&format!("{title}\n"))
    else {
        panic!("{title} is not a YAML mapping");
    };
    assert_eq!(
        parsed.get("title").and_then(|v| v.as_str()),
        Some("A \"quoted\": name")
    );
}

#[test]
fn the_manifest_keeps_the_spec_s_order() {
    let (_temp, _codes, manifest) = made(KindChoice::Ssg {
        engine: SiteEngine::Astro,
    });
    let keys: Vec<&str> = manifest.raw().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "fjord",
            "id",
            "name",
            "createdAt",
            "generator",
            "kind",
            "ssg",
            "vaults"
        ]
    );
}

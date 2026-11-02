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

// --- Setting up a repository that is not a Fjord repository as a kind ----------------------------------------

use scaffold::{KindSetup, KindSetupError, SetupKind};

/// Somebody's repository, with a README and their own .gitattributes, set up as `kind`: the plan, written over it, and verified.
fn set_up(
    kind: SetupKind,
    extra: &[(&str, &str)],
) -> Result<(tempfile::TempDir, Vec<String>), KindSetupError> {
    let temp = tempfile::tempdir().expect("temporary directory");
    let mut existing = vec![
        ("README.md", "# Mine\n"),
        (".gitattributes", "*.png binary\n"),
    ];
    existing.extend_from_slice(extra);
    for (path, text) in &existing {
        let at = temp.path().join(path);
        std::fs::create_dir_all(at.parent().expect("parent")).expect("mkdir");
        std::fs::write(at, text).expect("write");
    }
    let paths: Vec<&str> = existing.iter().map(|(path, _)| *path).collect();
    let plan = scaffold::plan_setup_kind(
        &KindSetup {
            repository_name: "Mine".to_string(),
            generator: "fjord test".to_string(),
            kind,
        },
        &origin(),
        &paths,
        Some("*.png binary\n"),
    )?;
    for file in &plan.files {
        let at = temp.path().join(&file.path);
        std::fs::create_dir_all(at.parent().expect("parent")).expect("mkdir");
        std::fs::write(at, &file.contents).expect("write");
    }
    assert_eq!(
        std::fs::read_to_string(temp.path().join("README.md")).expect("README"),
        "# Mine\n",
        "somebody's README is left as it was"
    );
    let report = verify::verify(temp.path(), &Options::default()).expect("verify");
    let codes = report
        .diagnostics
        .iter()
        .map(|d| d.code.as_str().to_string())
        .collect();
    Ok((temp, codes))
}

#[test]
fn a_repository_is_set_up_as_a_plaintext_journal() {
    let (temp, codes) = set_up(
        SetupKind::Journal {
            vault: "journal".to_string(),
            encrypted: false,
            recipients: vec![],
        },
        &[],
    )
    .expect("a plan");
    assert_eq!(codes, Vec::<String>::new());
    let manifest = Manifest::parse(&std::fs::read(temp.path().join("fjord.json")).expect("read"))
        .expect("parse");
    assert_eq!(manifest.presented_kind(), Kind::Journal);
    assert!(
        std::fs::read_to_string(temp.path().join(".gitattributes"))
            .expect("attributes")
            .starts_with("*.png binary\n"),
        "the merge guard is added at the end of what was there"
    );
}

#[test]
fn an_encrypted_journal_is_written_to_its_keys_at_once() {
    let key = fjord_core::crypto::generate_identity();
    let (temp, codes) = set_up(
        SetupKind::Journal {
            vault: "journal".to_string(),
            encrypted: true,
            recipients: vec![key.recipient.clone()],
        },
        &[],
    )
    .expect("a plan");
    // Not W602: the vault has its key, so it can be written to.
    assert_eq!(codes, Vec::<String>::new());
    let vault = Manifest::parse(
        &std::fs::read(temp.path().join("journal/fjord.vault.json")).expect("read"),
    )
    .expect("parse");
    assert_eq!(vault.file_naming(), Some("id"));
}

#[test]
fn a_repository_is_set_up_as_each_engine_s_site() {
    for engine in [SiteEngine::Astro, SiteEngine::Jekyll] {
        let (_temp, codes) = set_up(SetupKind::Ssg { engine }, &[]).expect("a plan");
        assert_eq!(codes, Vec::<String>::new(), "{engine:?}");
    }
}

#[test]
fn a_site_s_file_that_is_there_is_refused_not_written_over() {
    match set_up(
        SetupKind::Ssg {
            engine: SiteEngine::Astro,
        },
        &[("package.json", "{}\n")],
    ) {
        Err(KindSetupError::FileTaken(path)) => assert_eq!(path, "package.json"),
        other => panic!(
            "expected the file to be refused, got {:?}",
            other.map(|(_, codes)| codes)
        ),
    }
}

#[test]
fn a_fjord_repository_is_not_set_up_again() {
    match set_up(
        SetupKind::Ssg {
            engine: SiteEngine::Jekyll,
        },
        &[("fjord.json", "{}\n")],
    ) {
        Err(error) => assert_eq!(error.code(), "already_fjord"),
        Ok(_) => panic!("a repository with a fjord.json was set up"),
    }
}

#[test]
fn a_kind_is_changed_with_everything_else_kept() {
    let before = Manifest::parse(
        br#"{"fjord":1,"id":"01jagc4k7pqw2xn8rvty5zb3md","name":"N","createdAt":"2026-11-02T09:34:00Z","wiki":{"home":"x"},"ssg":{"theme":"dark"},"vaults":[]}"#,
    )
    .expect("parse");
    let journal = Manifest::parse(scaffold::with_kind(&before, &Kind::Journal, None).as_bytes())
        .expect("parse");
    assert_eq!(journal.presented_kind(), Kind::Journal);
    assert_eq!(journal.raw()["wiki"]["home"], "x");
    let site = Manifest::parse(
        scaffold::with_kind(&journal, &Kind::Ssg, Some(SiteEngine::Jekyll)).as_bytes(),
    )
    .expect("parse");
    assert_eq!(site.ssg_engine(), Some(Engine::Jekyll));
    assert_eq!(
        site.raw()["ssg"]["theme"],
        "dark",
        "the site's other settings are kept"
    );
    let keys: Vec<&str> = site.raw().keys().map(String::as_str).collect();
    assert_eq!(&keys[..5], ["fjord", "id", "name", "createdAt", "wiki"]);
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord new`, `ls`, `grep` and `status`.
//!
//! M5's acceptance criteria are two sentences, and the first two tests are
//! exactly them: `fjord new` produces a Doc that `fjord verify` passes, and
//! `grep` searches decrypted content in an encrypted vault.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}

impl Repo {
    fn run(&self, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &self.config)
            .env("TMPDIR", self.temp.path())
            .env("GIT_AUTHOR_NAME", "Fjord Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fjord Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .env_remove("FJORD_IDENTITY")
            .env_remove("EDITOR")
            .env_remove("VISUAL");
        command.output().expect("run fjord")
    }

    /// Run without the identity available, as a collaborator who cannot
    /// read the encrypted vault would.
    fn run_without_identity(&self, arguments: &[&str]) -> Output {
        let empty = self.temp.path().join("no-identity");
        std::fs::create_dir_all(&empty).expect("create");
        let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
        command
            .arg("-C")
            .arg(&self.root)
            .args(arguments)
            .env("NO_COLOR", "1")
            .env("FJORD_CONFIG_DIR", &empty)
            .env_remove("FJORD_IDENTITY");
        command.output().expect("run fjord")
    }
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("exit code")
}

fn out(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn err(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn repo() -> Repo {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("repo");
    let config = temp.path().join("config");
    let repo = Repo { temp, root, config };

    let init = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["init", &repo.root.to_string_lossy()])
        .env("NO_COLOR", "1")
        .env("GIT_AUTHOR_NAME", "Fjord Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fjord Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("init");
    assert_eq!(init.status.code(), Some(0), "{}", err(&init));

    let generated = Command::new(env!("CARGO_BIN_EXE_fjord"))
        .args(["key", "new", "--json"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &repo.config)
        .current_dir(repo.temp.path())
        .output()
        .expect("key new");
    assert_eq!(generated.status.code(), Some(0), "{}", err(&generated));
    let report: Value = serde_json::from_str(&out(&generated)).expect("json");
    let recipient = report["recipient"].as_str().expect("recipient").to_string();

    let added = repo.run(&["key", "add", &recipient, "--vault", "Private"]);
    assert_eq!(code(&added), 0, "{}", err(&added));

    repo
}

// --- The acceptance criteria ---------------------------------------------

/// "`fjord new` produces a Doc that `fjord verify` passes."
#[test]
fn a_new_document_passes_verify() {
    let repo = repo();

    for path in [
        "Public/plain.md",
        "Private/secret.md",
        "Public/Nested/deeper.md",
    ] {
        let created = repo.run(&["new", path, "--no-edit"]);
        assert_eq!(code(&created), 0, "{path}: {}", err(&created));

        let verified = repo.run(&["verify"]);
        assert_eq!(
            code(&verified),
            0,
            "verify failed after creating {path}: {}",
            out(&verified)
        );
    }

    // And the plaintext one really is a Doc, with every field §8.1 fixes.
    let listed = repo.run(&["ls", "Public", "--json", "-R"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let doc = rows
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["path"] == "Public/plain.md")
        .expect("plain.md");
    assert_eq!(doc["kind"], Value::from("doc"));
    assert_eq!(doc["title"], Value::from("plain"));
    assert_eq!(doc["id"].as_str().map(str::len), Some(26));
}

/// ROADMAP P2: "`fjord new --document` writes `name.fj.md`; `ls` shows which is which. Created file verifies;
/// `ls --json` reports `kind`."
#[test]
fn a_new_document_is_named_fj_md_verifies_and_is_listed_as_a_document() {
    let repo = repo();

    for (given, written) in [
        ("Public/plan", "Public/plan.fj.md"),
        ("Public/Q4/report.md", "Public/Q4/report.fj.md"),
        ("Public/already.fj.md", "Public/already.fj.md"),
    ] {
        let created = repo.run(&["new", given, "--document", "--no-edit"]);
        assert_eq!(code(&created), 0, "{given}: {}", err(&created));
        assert!(
            out(&created).contains(written),
            "{given}: {}",
            out(&created)
        );
        assert!(repo.root.join(written).is_file(), "{written} should exist");
    }

    let verified = repo.run(&["verify"]);
    assert_eq!(code(&verified), 0, "{}", out(&verified));

    // A note beside them, which is the same format and a different name.
    assert_eq!(code(&repo.run(&["new", "Public/idea.md", "--no-edit"])), 0);

    let listed = repo.run(&["ls", "Public", "--json", "-R"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let find = |path: &str| {
        rows.as_array()
            .expect("array")
            .iter()
            .find(|row| row["path"] == path)
            .unwrap_or_else(|| panic!("{path} not listed"))
            .clone()
    };
    // `kind` stays what it was, a Fjord Doc, so nothing that read it breaks; `docKind` says which.
    for (path, docs) in [
        ("Public/plan.fj.md", "document"),
        ("Public/Q4/report.fj.md", "document"),
        ("Public/already.fj.md", "document"),
        ("Public/idea.md", "note"),
        ("Public/welcome.md", "note"),
    ] {
        let row = find(path);
        assert_eq!(row["kind"], Value::from("doc"), "{path}");
        assert_eq!(row["docKind"], Value::from(docs), "{path}");
    }
    // A document's title does not keep its suffix.
    assert_eq!(find("Public/plan.fj.md")["title"], Value::from("plan"));

    // And the human listing says it too: the long one, which reads the files to know they are Docs.
    let human = repo.run(&["ls", "Public", "--long"]);
    let plan = out(&human)
        .lines()
        .find(|line| line.contains("plan.fj.md"))
        .expect("plan.fj.md")
        .to_string();
    assert!(plan.contains("document"), "{plan}");
    let idea = out(&human)
        .lines()
        .find(|line| line.contains("idea.md"))
        .expect("idea.md")
        .to_string();
    assert!(
        idea.contains("note") && !idea.contains("document"),
        "{idea}"
    );
}

#[test]
fn a_name_ending_in_fj_md_is_a_document_without_the_flag() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Public/plan.fj.md", "--no-edit"])),
        0
    );
    let listed = repo.run(&["ls", "Public", "--json"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let row = rows
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["path"] == "Public/plan.fj.md")
        .expect("listed");
    assert_eq!(row["docKind"], Value::from("document"));
}

/// Only Fjord Docs have a kind of Fjord Doc: a vault file, a directory and a vault do not.
#[test]
fn only_a_fjord_doc_has_a_doc_kind() {
    let repo = repo();
    std::fs::write(
        repo.root.join("Public/draft.fj.md"),
        "# no frontmatter, so not a Doc\n",
    )
    .expect("write");
    let listed = repo.run(&["ls", "Public", "--json"]);
    let rows: Value = serde_json::from_str(&out(&listed)).expect("json");
    let draft = rows
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["path"] == "Public/draft.fj.md")
        .expect("listed");
    // A `.fj.md` name makes a document only if the file is a Doc (§8.4): this one is a vault file.
    assert_eq!(draft["kind"], Value::from("file"));
    assert_eq!(draft["docKind"], Value::Null);

    let root = repo.run(&["ls", "--json"]);
    for row in serde_json::from_str::<Value>(&out(&root))
        .expect("json")
        .as_array()
        .expect("array")
    {
        assert_eq!(row["docKind"], Value::Null, "{row}");
    }
}

/// "`grep` searches decrypted content in an encrypted vault."
#[test]
fn grep_searches_inside_an_encrypted_vault() {
    let repo = repo();

    // A document whose text exists only inside the ciphertext.
    let source = repo.root.join("Private/notes.md");
    std::fs::write(
        &source,
        "# Notes\n\nthe passphrase is hunter2\nand nothing else\n",
    )
    .expect("write");
    assert_eq!(code(&repo.run(&["encrypt", "Private/notes.md"])), 0);

    // Not findable by ordinary means: that is the point of the vault.
    let plain = Command::new("grep")
        .args(["-r", "hunter2", "."])
        .current_dir(&repo.root)
        .output()
        .expect("grep");
    assert!(
        !plain.status.success(),
        "the plaintext was readable without decrypting: {}",
        String::from_utf8_lossy(&plain.stdout)
    );

    // Findable by fjord, which decrypts to search.
    let found = repo.run(&["grep", "hunter2"]);
    assert_eq!(code(&found), 0, "{}", err(&found));
    assert!(
        out(&found).contains("Private/notes.md:3:"),
        "expected a hit with its line number, got: {}",
        out(&found)
    );
    assert!(out(&found).contains("hunter2"));
}

// --- new -----------------------------------------------------------------

#[test]
fn a_new_document_in_an_encrypted_vault_is_never_in_the_clear() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Private/secret.md", "--no-edit"])),
        0
    );

    // The payload exists and the plaintext never did.
    assert!(repo.root.join("Private/secret.md.age").is_file());
    assert!(!repo.root.join("Private/secret.md").exists());

    // And it is a real age file that decrypts to a real Doc.
    let decrypted = repo.run(&["decrypt", "Private/secret.md.age"]);
    assert_eq!(code(&decrypted), 0, "{}", err(&decrypted));
    assert!(out(&decrypted).starts_with("---\n"));
    assert!(out(&decrypted).contains("title: secret"));
}

#[test]
fn a_title_can_be_given_and_defaults_to_the_file_stem() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Public/sync-design.md", "--no-edit"])),
        0
    );
    assert!(
        std::fs::read_to_string(repo.root.join("Public/sync-design.md"))
            .expect("read")
            .contains("title: sync-design")
    );

    assert_eq!(
        code(&repo.run(&[
            "new",
            "Public/other.md",
            "--title",
            "Notes: the sequel",
            "--no-edit"
        ])),
        0
    );
    let text = std::fs::read_to_string(repo.root.join("Public/other.md")).expect("read");
    // A colon in a title must be escaped, not emitted raw.
    assert!(text.contains("Notes: the sequel"), "{text}");
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn the_extension_is_added_and_other_extensions_refused() {
    let repo = repo();
    assert_eq!(code(&repo.run(&["new", "Public/bare", "--no-edit"])), 0);
    assert!(repo.root.join("Public/bare.md").is_file());

    let refused = repo.run(&["new", "Public/report.pdf", "--no-edit"]);
    assert_eq!(code(&refused), 2);
    assert!(err(&refused).contains("§8"), "{}", err(&refused));
}

#[test]
fn a_name_that_breaks_the_path_rules_is_refused_before_it_is_written() {
    let repo = repo();
    // §5: these cannot be checked out on some platform, so they are never
    // created in the first place. The rule applies to every component, not
    // just the file name — a directory ending in a space is as fatal on
    // Windows as a file ending in one.
    for name in ["Public/a?b.md", "Public/CON.md", "Public/folder /notes.md"] {
        let refused = repo.run(&["new", name, "--no-edit"]);
        assert_eq!(code(&refused), 2, "{name} was accepted");
        assert!(err(&refused).contains("E5"), "{name}: {}", err(&refused));
    }

    // A space *within* a name is fine: §5 rule 3 forbids only a trailing
    // one, and rejecting more than the spec does would be its own bug.
    assert_eq!(
        code(&repo.run(&["new", "Public/sync design.md", "--no-edit"])),
        0
    );
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

#[test]
fn a_document_outside_every_vault_is_refused() {
    let repo = repo();
    let refused = repo.run(&["new", "loose.md", "--no-edit"]);
    assert_eq!(code(&refused), 2);
    assert!(
        err(&refused).contains("not inside a vault"),
        "{}",
        err(&refused)
    );
    assert!(!repo.root.join("loose.md").exists());
}

#[test]
fn an_existing_document_is_never_written_over() {
    let repo = repo();
    assert_eq!(code(&repo.run(&["new", "Public/notes.md", "--no-edit"])), 0);
    let first = std::fs::read_to_string(repo.root.join("Public/notes.md")).expect("read");

    let again = repo.run(&["new", "Public/notes.md", "--no-edit"]);
    assert_eq!(code(&again), 2);
    assert_eq!(
        std::fs::read_to_string(repo.root.join("Public/notes.md")).expect("read"),
        first
    );
}

#[test]
fn without_an_editor_the_document_is_still_created() {
    // Not opening it is worth saying; failing would throw away the work.
    let repo = repo();
    let created = repo.run(&["new", "Public/notes.md"]);
    assert_eq!(code(&created), 0, "{}", err(&created));
    assert!(repo.root.join("Public/notes.md").is_file());
    assert!(err(&created).contains("no editor"), "{}", err(&created));
}

#[test]
fn new_opens_the_editor_and_the_edit_survives() {
    let repo = repo();
    let editor = repo.temp.path().join("append.sh");
    std::fs::write(&editor, "#!/bin/sh\nprintf 'a line\\n' >> \"$1\"\n").expect("write");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&editor, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    let mut command = Command::new(env!("CARGO_BIN_EXE_fjord"));
    let created = command
        .arg("-C")
        .arg(&repo.root)
        .args(["new", "Private/journal.md"])
        .env("NO_COLOR", "1")
        .env("FJORD_CONFIG_DIR", &repo.config)
        .env("TMPDIR", repo.temp.path())
        .env("EDITOR", &editor)
        .env_remove("FJORD_IDENTITY")
        .output()
        .expect("run");
    assert_eq!(created.status.code(), Some(0), "{}", err(&created));

    let decrypted = repo.run(&["decrypt", "Private/journal.md.age"]);
    assert!(out(&decrypted).ends_with("a line\n"), "{}", out(&decrypted));
    assert_eq!(code(&repo.run(&["verify"])), 0);
}

// --- ls ------------------------------------------------------------------

#[test]
fn ls_lists_vaults_at_the_root_and_contents_within() {
    let repo = repo();
    assert_eq!(code(&repo.run(&["new", "Public/one.md", "--no-edit"])), 0);
    assert_eq!(
        code(&repo.run(&["new", "Public/Deep/two.md", "--no-edit"])),
        0
    );

    let root = repo.run(&["ls"]);
    assert_eq!(code(&root), 0, "{}", err(&root));
    assert!(out(&root).contains("Public"));
    assert!(out(&root).contains("Private"));
    // Not the documents: a vault is one line until asked otherwise.
    assert!(!out(&root).contains("one.md"), "{}", out(&root));

    let inside = repo.run(&["ls", "Public"]);
    assert!(out(&inside).contains("Public/one.md"));
    assert!(out(&inside).contains("Public/welcome.md"));
    // A subdirectory collapses into one row.
    assert!(out(&inside).contains("Public/Deep"));
    assert!(!out(&inside).contains("two.md"), "{}", out(&inside));

    let recursive = repo.run(&["ls", "Public", "-R"]);
    assert!(
        out(&recursive).contains("Public/Deep/two.md"),
        "{}",
        out(&recursive)
    );
}

#[test]
fn a_payload_is_listed_under_its_logical_name() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Private/secret.md", "--no-edit"])),
        0
    );

    let listed = repo.run(&["ls", "Private"]);
    assert!(
        out(&listed).contains("Private/secret.md"),
        "{}",
        out(&listed)
    );
    // The user should not have to think about `.age`.
    assert!(!out(&listed).contains(".age"), "{}", out(&listed));
}

#[test]
fn a_plain_listing_reads_no_contents() {
    // In a `plain` vault the names are already visible to anyone who can
    // read the repository (§11.2), so listing must not require a key.
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Private/secret.md", "--no-edit"])),
        0
    );

    let listed = repo.run_without_identity(&["ls", "Private"]);
    assert_eq!(code(&listed), 0, "{}", err(&listed));
    assert!(out(&listed).contains("Private/secret.md"));
}

#[test]
fn long_listing_shows_the_id_and_title() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Private/secret.md", "--title", "Buried", "--no-edit"])),
        0
    );

    let listed = repo.run(&["ls", "Private", "--long"]);
    assert_eq!(code(&listed), 0, "{}", err(&listed));
    assert!(out(&listed).contains("Buried"), "{}", out(&listed));

    // Without an identity it lists what it can and says what it could not.
    let blind = repo.run_without_identity(&["ls", "Private", "--long"]);
    assert_eq!(code(&blind), 0, "{}", err(&blind));
    assert!(out(&blind).contains("Private/secret.md"));
    assert!(!out(&blind).contains("Buried"));
    assert!(out(&blind).contains("could not be read"), "{}", out(&blind));
}

// --- grep ----------------------------------------------------------------

/// §8.2 makes a Markdown file without frontmatter a vault file, not a
/// broken Doc. Reporting it as unreadable told users their key was wrong.
#[test]
fn a_file_without_frontmatter_is_not_called_unreadable() {
    let repo = repo();
    // Written by hand, the way a file arriving from another editor is.
    std::fs::write(
        repo.root.join("Private/plain.md"),
        "# Plain\n\nno frontmatter\n",
    )
    .expect("write");
    assert_eq!(code(&repo.run(&["encrypt", "Private/plain.md"])), 0);

    let listed = repo.run(&["ls", "Private", "--long"]);
    assert_eq!(code(&listed), 0, "{}", err(&listed));
    assert!(
        out(&listed).contains("Private/plain.md"),
        "{}",
        out(&listed)
    );
    assert!(
        !out(&listed).contains("could not be read"),
        "a file with no frontmatter was reported as undecryptable: {}",
        out(&listed)
    );

    // And it is listed as a file rather than a doc, which is what it is.
    let json = repo.run(&["ls", "Private", "--json"]);
    let rows: Value = serde_json::from_str(&out(&json)).expect("json");
    let row = rows
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["path"] == "Private/plain.md")
        .expect("plain.md");
    assert_eq!(row["kind"], Value::from("file"));
    assert_eq!(row["id"], Value::Null);

    // Whereas a genuinely unreadable one still says so.
    let blind = repo.run_without_identity(&["ls", "Private", "--long"]);
    assert!(out(&blind).contains("could not be read"), "{}", out(&blind));
}

#[test]
fn grep_searches_plaintext_vaults_too() {
    let repo = repo();
    std::fs::write(repo.root.join("Public/notes.md"), "# Notes\n\nfindable\n").expect("write");

    let found = repo.run(&["grep", "findable"]);
    assert_eq!(code(&found), 0);
    assert!(
        out(&found).contains("Public/notes.md:3:findable"),
        "{}",
        out(&found)
    );
}

#[test]
fn grep_can_ignore_case_and_be_scoped() {
    let repo = repo();
    std::fs::write(repo.root.join("Public/one.md"), "Needle\n").expect("write");
    std::fs::write(repo.root.join("Public/two.md"), "needle\n").expect("write");

    assert_eq!(out(&repo.run(&["grep", "needle"])).lines().count(), 1);
    assert_eq!(
        out(&repo.run(&["grep", "needle", "--ignore-case"]))
            .lines()
            .count(),
        2
    );

    let scoped = repo.run(&["grep", "needle", "Public/two.md"]);
    assert_eq!(out(&scoped).lines().count(), 1);
    assert!(out(&scoped).contains("two.md"));
}

#[test]
fn no_matches_is_not_an_error() {
    // Deliberately unlike grep(1): exit 1 means "problems found in the
    // repository" in this toolchain, and a search that found nothing is
    // not a problem.
    let repo = repo();
    let found = repo.run(&["grep", "nothing-matches-this"]);
    assert_eq!(code(&found), 0);
    assert_eq!(out(&found), "");

    let json = repo.run(&["grep", "nothing-matches-this", "--json"]);
    let report: Value = serde_json::from_str(&out(&json)).expect("json");
    assert_eq!(report["matches"].as_array().map(Vec::len), Some(0));
}

#[test]
fn grep_says_what_it_could_not_search() {
    let repo = repo();
    std::fs::write(repo.root.join("Private/notes.md"), "secret text\n").expect("write");
    assert_eq!(code(&repo.run(&["encrypt", "Private/notes.md"])), 0);

    let blind = repo.run_without_identity(&["grep", "secret"]);
    assert_eq!(code(&blind), 0, "{}", err(&blind));
    assert_eq!(out(&blind), "", "it should not have found anything");
    assert!(err(&blind).contains("Private"), "{}", err(&blind));
    assert!(err(&blind).contains("identity"), "{}", err(&blind));
}

// --- status --------------------------------------------------------------

#[test]
fn status_reports_conformance_vaults_and_git() {
    let repo = repo();
    let shown = repo.run(&["status"]);
    assert_eq!(code(&shown), 0, "{}", err(&shown));
    let text = out(&shown);

    assert!(text.contains("Public"), "{text}");
    assert!(text.contains("Private"), "{text}");
    assert!(text.contains("conforms"), "{text}");
    assert!(text.contains("git on main"), "{text}");
    // `key add` edited the recipients file and nothing has been committed.
    assert!(text.contains("uncommitted"), "{text}");
}

/// `git status --porcelain` encodes meaning in a leading space, and the
/// first changed path used to lose its first character to a stray trim.
#[test]
fn changed_paths_are_reported_whole() {
    let repo = repo();
    // An unstaged modification, whose porcelain line begins with a space.
    std::fs::write(repo.root.join("Public/welcome.md"), "edited\n").expect("write");

    let shown = repo.run(&["status", "--json"]);
    let report: Value = serde_json::from_str(&out(&shown)).expect("json");
    let changes: Vec<&str> = report["git"]["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .filter_map(Value::as_str)
        .collect();

    assert!(
        changes.contains(&"Public/welcome.md"),
        "a path lost characters: {changes:?}"
    );
    for path in &changes {
        assert!(
            repo.root.join(path).exists() || path.ends_with('/'),
            "{path} is not a real path, so it was mangled"
        );
    }
}

/// An encrypted vault's doc count would always be zero, because nothing is
/// decrypted to find out — so it is not claimed at all.
#[test]
fn an_encrypted_vault_does_not_claim_a_doc_count() {
    let repo = repo();
    assert_eq!(
        code(&repo.run(&["new", "Private/secret.md", "--no-edit"])),
        0
    );

    for arguments in [vec!["status"], vec!["verify"]] {
        let shown = repo.run(&arguments);
        let text = out(&shown);
        let private = text
            .lines()
            .find(|line| line.contains("Private"))
            .unwrap_or_default();
        assert!(private.contains("1 file"), "{arguments:?}: {private}");
        assert!(
            !private.contains("doc"),
            "{arguments:?} claimed a doc count it cannot know: {private}"
        );
    }

    // `ls --long` decrypts, so it genuinely can tell.
    let listed = repo.run(&["ls", "Private", "--long"]);
    assert!(out(&listed).contains("secret"), "{}", out(&listed));
}

#[test]
fn status_json_describes_the_same_thing() {
    let repo = repo();
    let shown = repo.run(&["status", "--json"]);
    assert_eq!(code(&shown), 0, "{}", err(&shown));
    let report: Value = serde_json::from_str(&out(&shown)).expect("json");

    assert_eq!(report["conforms"], Value::Bool(true));
    assert_eq!(report["readOnly"], Value::Bool(false));
    assert_eq!(report["vaults"].as_array().map(Vec::len), Some(2));
    assert_eq!(report["git"]["branch"], Value::from("main"));
    // No remote configured, so there is nothing to be ahead or behind of.
    assert_eq!(report["git"]["ahead"], Value::Null);
    assert!(report["git"]["changes"].as_array().is_some());
}

#[test]
fn status_reports_a_problem_it_finds() {
    let repo = repo();
    // Plaintext in an encrypted vault: the most serious diagnostic.
    std::fs::write(repo.root.join("Private/stray.md"), "in the clear\n").expect("write");

    let shown = repo.run(&["status"]);
    assert_eq!(code(&shown), 0, "status itself should still succeed");
    assert!(out(&shown).contains("fjord verify"), "{}", out(&shown));
    assert!(out(&shown).contains("1 error"), "{}", out(&shown));
}

/// Keep `Path` referenced for the helpers above.
#[allow(dead_code)]
fn _path(_: &Path) {}

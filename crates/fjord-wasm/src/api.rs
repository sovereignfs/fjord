// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! What the WebAssembly module offers, as plain Rust.
//!
//! Everything here takes and returns strings, bytes and numbers, and structured results are **JSON
//! text**: `JSON.parse` on the other side, no object-marshalling layer in the module, nothing to
//! drift between this crate and its caller but a documented shape. It is separate from
//! `lib.rs`, which only wraps each function for JavaScript, so it is tested natively (`cargo test`)
//! and the JavaScript suite then checks that the module built from it answers the same.
//!
//! A *finding about the input* (a manifest that is not JSON, a document with broken frontmatter) is
//! data, not an error: it comes back in the JSON. `Err` is for a call that is itself malformed (a
//! list of files that is not JSON): the programmer's mistake, thrown on the JavaScript side.
//!
//! No clock and no random source: a caller that makes an identifier or a timestamp supplies the
//! time and the randomness (`crypto.getRandomValues`, `Date.now()`).

use fjord_core::doc::{self, Parse};
use fjord_core::listing::{self, FileKind, ListedFile};
use fjord_core::manifest::{field, Manifest, Vaults};
use fjord_core::{path, scalar};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// The format version this build implements.
pub fn format_version() -> u32 {
    fjord_core::FORMAT_VERSION
}

// --- Discovery -----------------------------------------------------------

/// `[{"path": "Notes/a.md", "size": 120}, …]`: the files of a repository, as a tree listing gives
/// them. `size` may be left out. A directory is not a file; a symbolic link is.
fn files(json: &str) -> Result<Vec<ListedFile>, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|err| format!("the file list is not JSON: {err}"))?;
    let items = value.as_array().ok_or("the file list must be an array")?;
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let path = item
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("file {index} has no `path`"))?;
            let size = item.get("size").and_then(Value::as_u64).unwrap_or(0);
            Ok(ListedFile {
                path: path.to_string(),
                size,
            })
        })
        .collect()
}

/// The manifests a client has to fetch to call [`discover`]: the vault manifests at the root.
/// A JSON array of repository-relative paths. (`fjord.json` is always at `fjord.json`.)
pub fn manifest_paths(files_json: &str) -> Result<String, String> {
    Ok(json!(listing::manifest_paths(&files(files_json)?)).to_string())
}

fn kind_name(kind: FileKind) -> &'static str {
    match kind {
        FileKind::Payload => "payload",
        FileKind::Stray => "stray",
        FileKind::MisplacedPayload => "misplacedPayload",
        FileKind::Document => "document",
        FileKind::Note => "note",
        FileKind::Other => "other",
    }
}

/// The vaults of a repository and what is in them (spec §2, §4, §6.3), from its listing and the text
/// of its vault manifests, `{"Notes/fjord.vault.json": "<the file's text>", …}`.
///
/// ```json
/// { "vaults": [ { "directory": "Notes", "name": "Notes", "encrypted": false, "fileNaming": "plain",
///                 "suffix": ".age", "manifestError": null,
///                 "files": [ { "path": "Notes/a.md", "relative": "a.md", "logical": "a.md",
///                              "kind": "note", "size": 120 } ] } ],
///   "nested": [ "Notes/Inner" ] }
/// ```
///
/// `kind` is `payload`, `stray`, `misplacedPayload`, `document` (`*.fj.md`), `note` (any other `.md`) or
/// `other`, spec §8.4; machinery (the manifest,
/// `.gitignore`, the recipients file) is not listed. A vault whose manifest is missing or not JSON has
/// `manifestError` set and no files, as `fjord verify` treats it.
pub fn discover(files_json: &str, manifests_json: &str) -> Result<String, String> {
    let listed = files(files_json)?;
    let value: Value = serde_json::from_str(manifests_json)
        .map_err(|err| format!("the manifests are not JSON: {err}"))?;
    let object = value
        .as_object()
        .ok_or("the manifests must be an object of path to text")?;
    let mut manifests: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (path, text) in object {
        let text = text
            .as_str()
            .ok_or_else(|| format!("the manifest {path} must be text"))?;
        manifests.insert(path.clone(), text.as_bytes().to_vec());
    }

    let found = listing::discover(&listed, &manifests);
    let vaults: Vec<Value> = found
        .vaults
        .iter()
        .map(|vault| {
            let (name, file_naming, manifest_error) = match &vault.manifest {
                Ok(manifest) => (
                    manifest.string(field::NAME).map(str::to_string),
                    Some(manifest.file_naming().unwrap_or("plain").to_string()),
                    None,
                ),
                Err(problem) => (None, None, Some(problem.clone())),
            };
            json!({
                "directory": vault.directory,
                "name": name,
                "encrypted": vault.settings.as_ref().map(|s| s.encrypted),
                "fileNaming": file_naming,
                "suffix": vault.settings.as_ref().map(|s| s.suffix.clone()),
                "manifestError": manifest_error,
                "files": vault.files.iter().map(|file| json!({
                    "path": file.path, "relative": file.relative, "logical": file.logical,
                    "kind": kind_name(file.kind), "size": file.size,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "vaults": vaults, "nested": found.nested }).to_string())
}

// --- Manifests -----------------------------------------------------------

fn parse_manifest(text: &str) -> Result<Manifest, String> {
    Manifest::parse(text.as_bytes()).map_err(|err| err.to_string())
}

fn failed(error: String) -> String {
    json!({ "ok": false, "error": error }).to_string()
}

/// `fjord.json`, read: `{ "ok": true, "version", "id", "name", "createdAt", "vaultsState", "vaults":
/// [{"path", "id"}], "raw" }`, where `raw` is the whole manifest as written (what a rewrite must
/// preserve, spec §10.1) and `vaultsState` is `entries`, `absent` or `notAnArray`. Or `{ "ok": false,
/// "error" }` when it is not a JSON object. Spec §3.
pub fn describe_repository_manifest(text: &str) -> String {
    let manifest = match parse_manifest(text) {
        Ok(manifest) => manifest,
        Err(error) => return failed(error),
    };
    let (state, vaults) = match manifest.vaults() {
        Vaults::Absent => ("absent", Value::Null),
        Vaults::NotAnArray => ("notAnArray", Value::Null),
        Vaults::Entries(entries) => (
            "entries",
            json!(entries
                .iter()
                .map(|e| json!({ "path": e.path, "id": e.id }))
                .collect::<Vec<_>>()),
        ),
    };
    json!({
        "ok": true,
        "version": manifest.version(),
        "id": manifest.string(field::ID),
        "name": manifest.string(field::NAME),
        "createdAt": manifest.string(field::CREATED_AT),
        "vaultsState": state,
        "vaults": vaults,
        "raw": Value::Object(manifest.raw().clone()),
    })
    .to_string()
}

/// `fjord.vault.json`, read: `{ "ok": true, "version", "id", "name", "fileNaming", "encrypted",
/// "suffix", "recipients", "raw" }`, or `{ "ok": false, "error" }`. Spec §4.
pub fn describe_vault_manifest(text: &str) -> String {
    let manifest = match parse_manifest(text) {
        Ok(manifest) => manifest,
        Err(error) => return failed(error),
    };
    let settings = listing::VaultSettings::from_manifest(&manifest);
    let recipients = match manifest.encryption() {
        fjord_core::manifest::EncryptionField::Object(object) => {
            fjord_core::manifest::object_string(object, field::RECIPIENTS).map(str::to_string)
        }
        _ => None,
    };
    json!({
        "ok": true,
        "version": manifest.version(),
        "id": manifest.string(field::ID),
        "name": manifest.string(field::NAME),
        "fileNaming": manifest.file_naming().unwrap_or("plain"),
        "encrypted": settings.encrypted,
        "suffix": settings.suffix,
        "recipients": recipients,
        "raw": Value::Object(manifest.raw().clone()),
    })
    .to_string()
}

// --- Path rules (spec §5) ------------------------------------------------

/// The path rules a single name breaks, as a JSON array of diagnostic codes (`E501`…): empty if it is
/// fine. Checks one component, not a path.
pub fn check_name(component: &str) -> String {
    json!(path::check_component(component)
        .iter()
        .map(|code| code.as_str())
        .collect::<Vec<_>>())
    .to_string()
}

/// Groups of names in one directory that differ only by case (rule 6): `[["Notes.md","notes.md"]]`.
pub fn case_collisions(names_json: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(names_json).map_err(|err| format!("the names are not JSON: {err}"))?;
    let names: Vec<String> = value
        .as_array()
        .ok_or("the names must be an array")?
        .iter()
        .map(|name| {
            name.as_str()
                .map(str::to_string)
                .ok_or("every name must be text")
        })
        .collect::<Result<_, _>>()?;
    Ok(json!(path::case_collisions(&names)).to_string())
}

/// A name in Unicode normalisation form C, which §5 requires of every path.
pub fn to_nfc(name: &str) -> String {
    path::to_nfc(name)
}

/// The diagnostic code a path read from a manifest breaks (`E503` for traversal), or `None` if it may
/// be followed. Spec §5, §11.5: a manifest is untrusted input.
pub fn check_manifest_path(candidate: &str) -> Option<String> {
    path::check_manifest_path(candidate).map(|code| code.as_str().to_string())
}

// --- Documents (spec §8) -------------------------------------------------

/// What a file's head says, as JSON. `{ "status": … }` is `absent` (a vault file, which is valid),
/// `notAtStart`, `unterminated`, `notAMapping`, `unparseable` (with `message`) or `present`, which also
/// carries `frontmatter` (every key, in order, as JSON), `id` (as written), `docId` (the `id` only if it
/// is a valid ULID, which is what makes the file a Doc), `title`, `created` and `bodyOffset` (a byte offset
/// into the text, just past the closing fence).
pub fn parse_document(text: &str) -> String {
    match doc::parse(text) {
        Parse::Absent => json!({ "status": "absent" }),
        Parse::NotAtStart => json!({ "status": "notAtStart" }),
        Parse::Unterminated => json!({ "status": "unterminated" }),
        Parse::NotAMapping => json!({ "status": "notAMapping" }),
        Parse::Unparseable(message) => json!({ "status": "unparseable", "message": message }),
        Parse::Present {
            frontmatter,
            body_offset,
        } => {
            let mut keys = Map::new();
            for (key, value) in frontmatter.raw() {
                keys.insert(
                    key.clone(),
                    serde_json::to_value(value).unwrap_or(Value::Null),
                );
            }
            json!({
                "status": "present",
                "frontmatter": keys,
                "id": frontmatter.id(),
                "docId": frontmatter.doc_id(),
                "title": frontmatter.title(),
                "created": frontmatter.created(),
                "bodyOffset": body_offset,
            })
        }
    }
    .to_string()
}

/// A new Doc: frontmatter (`id`, `title`, `created`) and a level-one heading. The mapping is written by
/// a YAML writer, so a title with a colon or a quote cannot make a file this crate refuses to read.
pub fn new_document(id: &str, title: &str, created: &str) -> Result<String, String> {
    doc::new_document(id, title, created).map_err(|err| err.to_string())
}

/// A copy of a document with a fresh `id`, every other key and its order kept (spec §9.1), or `None`
/// for a file with no frontmatter.
pub fn with_fresh_id(text: &str, id: &str) -> Option<String> {
    doc::with_fresh_id(text, id)
}

/// A file given the frontmatter of a Doc, keeping whatever it has (unknown keys and their order
/// included, invariant 3). `title` and `created` are only filled in when absent. `None` for a file
/// whose frontmatter is there but broken: it is not ours to rewrite.
pub fn promote_document(text: &str, id: &str, created: &str, title: &str) -> Option<String> {
    doc::promote(text, id, created, title)
}

/// The title a document implies: its first level-one heading, else the file name without `.md`.
pub fn implied_title(text: &str, file_name: &str) -> String {
    doc::implied_title(text, file_name)
}

// --- Identifiers and time ------------------------------------------------

/// A new identifier (spec §8.3) from the time and the randomness the caller supplies: milliseconds since
/// the Unix epoch, and at least ten random bytes (an identifier holds 80 random bits, and is only as
/// unguessable as these are).
pub fn new_ulid(timestamp_ms: f64, random: &[u8]) -> Result<String, String> {
    if !timestamp_ms.is_finite() || timestamp_ms < 0.0 {
        return Err("the time must be milliseconds since the epoch, not negative".to_string());
    }
    if random.len() < 10 {
        return Err("an identifier needs at least ten random bytes".to_string());
    }
    let mut bytes = [0u8; 16];
    bytes[..random.len().min(16)].copy_from_slice(&random[..random.len().min(16)]);
    Ok(scalar::new_ulid_from(timestamp_ms as u64, bytes))
}

/// Whether `text` is an identifier in the one form §8.3 permits (lowercase ULID).
pub fn is_ulid(text: &str) -> bool {
    scalar::is_ulid(text)
}

/// Whether `text` is an RFC 3339 timestamp in UTC. Spec §3, §4, §8.1.
pub fn is_rfc3339_utc(text: &str) -> bool {
    scalar::is_rfc3339_utc(text)
}

/// Seconds since the Unix epoch as RFC 3339 in UTC, or `None` if it cannot be represented.
pub fn rfc3339_from_unix(seconds: f64) -> Option<String> {
    if !seconds.is_finite() {
        return None;
    }
    scalar::rfc3339_utc_from_unix(seconds as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).expect("JSON")
    }

    const PLAIN: &str = r#"{"id":"01j8z3k9t2v4w5x6y7z8a9b0c1","name":"Notes","version":1,"createdAt":"2026-01-01T00:00:00Z","fileNaming":"plain","encryption":null}"#;
    const SECRET: &str = r#"{"name":"Secret","encryption":{"tool":"age","recipients":"recipients.txt","suffix":".age","container":"none","armor":false}}"#;

    #[test]
    fn discovery_reports_vaults_files_kinds_and_nested_manifests() {
        let list = r#"[
            {"path":"fjord.json"},
            {"path":"Notes/fjord.vault.json"}, {"path":"Notes/a.md","size":12}, {"path":"Notes/.gitignore"},
            {"path":"Secret/fjord.vault.json"}, {"path":"Secret/recipients.txt"}, {"path":"Secret/x.md.age","size":99}, {"path":"Secret/leak.md"},
            {"path":"Notes/Inner/fjord.vault.json"}
        ]"#;
        let manifests =
            json!({ "Notes/fjord.vault.json": PLAIN, "Secret/fjord.vault.json": SECRET })
                .to_string();
        let found = parsed(&discover(list, &manifests).expect("discover"));

        assert_eq!(found["nested"], json!(["Notes/Inner"]));
        let vaults = found["vaults"].as_array().expect("vaults");
        assert_eq!(vaults.len(), 2);

        assert_eq!(vaults[0]["directory"], "Notes");
        assert_eq!(vaults[0]["name"], "Notes");
        assert_eq!(vaults[0]["encrypted"], false);
        // A nested vault manifest is reported in `nested`, and, being inside a vault, is also one of its files.
        let notes: Vec<&str> = vaults[0]["files"]
            .as_array()
            .expect("files")
            .iter()
            .map(|f| f["relative"].as_str().unwrap())
            .collect();
        assert_eq!(notes, ["Inner/fjord.vault.json", "a.md"]);
        assert_eq!(
            vaults[0]["files"][1],
            json!({ "path": "Notes/a.md", "relative": "a.md", "logical": "a.md", "kind": "note", "size": 12 })
        );

        assert_eq!(vaults[1]["encrypted"], true);
        assert_eq!(vaults[1]["suffix"], ".age");
        let kinds: Vec<(&str, &str)> = vaults[1]["files"]
            .as_array()
            .expect("files")
            .iter()
            .map(|f| (f["relative"].as_str().unwrap(), f["kind"].as_str().unwrap()))
            .collect();
        // The recipients file is machinery; a plaintext file is a stray; the payload is named without its suffix.
        assert_eq!(kinds, [("leak.md", "stray"), ("x.md.age", "payload")]);
        assert_eq!(vaults[1]["files"][1]["logical"], "x.md");
    }

    #[test]
    fn the_manifests_to_fetch_are_the_roots_vaults() {
        let list = r#"[{"path":"B/fjord.vault.json"},{"path":"A/fjord.vault.json"},{"path":"A/deep/fjord.vault.json"},{"path":"fjord.json"}]"#;
        assert_eq!(
            parsed(&manifest_paths(list).expect("paths")),
            json!(["A/fjord.vault.json", "B/fjord.vault.json"])
        );
    }

    #[test]
    fn a_vault_with_no_readable_manifest_is_listed_with_the_problem_and_no_files() {
        let list = r#"[{"path":"A/fjord.vault.json"},{"path":"A/a.md"},{"path":"B/fjord.vault.json"},{"path":"B/b.md"}]"#;
        let found =
            parsed(&discover(list, r#"{"B/fjord.vault.json":"not json"}"#).expect("discover"));
        for vault in found["vaults"].as_array().expect("vaults") {
            assert!(vault["manifestError"].is_string(), "{vault}");
            assert_eq!(vault["files"], json!([]));
            assert!(vault["encrypted"].is_null());
        }
    }

    #[test]
    fn a_malformed_call_is_an_error_and_not_a_result() {
        assert!(discover("nope", "{}").unwrap_err().contains("not JSON"));
        assert!(discover("{}", "{}").unwrap_err().contains("array"));
        assert!(discover(r#"[{"size":1}]"#, "{}")
            .unwrap_err()
            .contains("no `path`"));
        assert!(discover("[]", "[]").unwrap_err().contains("object"));
        assert!(discover("[]", r#"{"a":1}"#).unwrap_err().contains("text"));
        assert!(manifest_paths("nope").is_err());
        assert!(case_collisions("{}").is_err());
        assert!(case_collisions("[1]").is_err());
    }

    #[test]
    fn manifests_are_described_and_what_is_wrong_with_one_is_data() {
        let repo = parsed(&describe_repository_manifest(
            r#"{"fjord":1,"id":"01j8z3k9t2v4w5x6y7z8a9b0c1","name":"R","createdAt":"2026-01-01T00:00:00Z","vaults":[{"path":"Notes","id":"x"},{"nope":1}],"x-future":{"k":[1,2]}}"#,
        ));
        assert_eq!(repo["ok"], true);
        assert_eq!(repo["vaultsState"], "entries");
        assert_eq!(
            repo["vaults"],
            json!([{ "path": "Notes", "id": "x" }, { "path": null, "id": null }])
        );
        // Unknown fields are kept in `raw`: a rewrite must preserve them.
        assert_eq!(repo["raw"]["x-future"], json!({ "k": [1, 2] }));

        assert_eq!(
            parsed(&describe_repository_manifest(r#"{"vaults":5}"#))["vaultsState"],
            "notAnArray"
        );
        assert_eq!(
            parsed(&describe_repository_manifest("{}"))["vaultsState"],
            "absent"
        );
        for bad in ["", "[1]", "not json", "\u{feff}{}"] {
            let result = parsed(&describe_repository_manifest(bad));
            assert_eq!(result["ok"], false, "{bad:?}");
            assert!(result["error"].is_string());
        }

        let vault = parsed(&describe_vault_manifest(SECRET));
        assert_eq!(vault["encrypted"], true);
        assert_eq!(vault["recipients"], "recipients.txt");
        assert_eq!(vault["fileNaming"], "plain");
        assert_eq!(parsed(&describe_vault_manifest(PLAIN))["encrypted"], false);
        assert_eq!(parsed(&describe_vault_manifest("nope"))["ok"], false);
    }

    #[test]
    fn the_path_rules_name_the_codes_they_break() {
        assert_eq!(parsed(&check_name("fine.md")), json!([]));
        assert_eq!(parsed(&check_name("a:b.md")), json!(["E501"]));
        assert_eq!(parsed(&check_name("trailing ")), json!(["E502"]));
        assert_eq!(parsed(&check_name("CON.md")), json!(["E503"]));
        assert_eq!(
            parsed(&case_collisions(r#"["Notes.md","notes.md","other.md"]"#).unwrap()),
            json!([["Notes.md", "notes.md"]])
        );
        assert_eq!(to_nfc("e\u{301}"), "\u{e9}");
        assert_eq!(check_manifest_path("../x"), Some("E507".to_string()));
        assert!(check_manifest_path("/abs").is_some());
        assert!(check_manifest_path("a\\b").is_some());
        assert!(check_manifest_path("").is_some());
        assert_eq!(check_manifest_path("keys/recipients.txt"), None);
    }

    #[test]
    fn a_document_is_read_with_every_key_in_order() {
        let text = "---\nid: 01j8z3k9t2v4w5x6y7z8a9b0c1\ntitle: Plan\nfuture: {a: 1}\ntags: [x, y]\n---\n\n# Plan\n";
        let result = parsed(&parse_document(text));
        assert_eq!(result["status"], "present");
        assert_eq!(result["docId"], "01j8z3k9t2v4w5x6y7z8a9b0c1");
        assert_eq!(result["title"], "Plan");
        assert_eq!(result["frontmatter"]["future"], json!({ "a": 1 }));
        let keys: Vec<&str> = result["frontmatter"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["id", "title", "future", "tags"]);
        assert_eq!(
            &text[result["bodyOffset"].as_u64().unwrap() as usize..],
            "\n# Plan\n"
        );
    }

    #[test]
    fn what_is_not_a_document_is_said_so() {
        assert_eq!(parsed(&parse_document("# Just text\n"))["status"], "absent");
        assert_eq!(
            parsed(&parse_document("\n---\nid: x\n---\n"))["status"],
            "notAtStart"
        );
        assert_eq!(
            parsed(&parse_document("---\nid: x\n"))["status"],
            "unterminated"
        );
        assert_eq!(
            parsed(&parse_document("---\n- a\n---\n"))["status"],
            "notAMapping"
        );
        let broken = parsed(&parse_document("---\nid: [\n---\n"));
        assert_eq!(broken["status"], "unparseable");
        assert!(broken["message"].is_string());
        // A present `id` that is not an identifier is shown as written but is not a Doc's.
        let wrong = parsed(&parse_document("---\nid: not-a-ulid\n---\n"));
        assert_eq!(wrong["id"], "not-a-ulid");
        assert!(wrong["docId"].is_null());
    }

    #[test]
    fn a_new_document_reads_back_and_a_hostile_title_cannot_break_it() {
        let id = "01j8z3k9t2v4w5x6y7z8a9b0c1";
        let text = new_document(id, "Q4: plan \"final\" - v2", "2026-01-01T00:00:00Z").unwrap();
        let back = parsed(&parse_document(&text));
        assert_eq!(back["docId"], id);
        assert_eq!(back["title"], "Q4: plan \"final\" - v2");
    }

    #[test]
    fn promoting_keeps_what_was_there_and_a_fresh_id_changes_only_the_id() {
        let id = "01j8z3k9t2v4w5x6y7z8a9b0c1";
        let other = "01j8z3k9t2v4w5x6y7z8a9b0c2";
        let text = "---\ntitle: Mine\nzzz: kept\naaa: also\n---\nbody\n";
        let promoted =
            promote_document(text, id, "2026-01-01T00:00:00Z", "Ignored").expect("promoted");
        let back = parsed(&parse_document(&promoted));
        assert_eq!(back["docId"], id);
        assert_eq!(back["title"], "Mine");
        let keys: Vec<&str> = back["frontmatter"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["title", "zzz", "aaa", "id", "created"]);
        assert!(promoted.ends_with("body\n"));

        let renewed = with_fresh_id(&promoted, other).expect("renewed");
        assert_eq!(parsed(&parse_document(&renewed))["docId"], other);
        assert_eq!(with_fresh_id("no frontmatter", other), None);
        assert_eq!(promote_document("---\nid: [\n---\n", id, "c", "t"), None);
        assert_eq!(
            implied_title("intro\n# The Heading\n", "x.md"),
            "The Heading"
        );
        assert_eq!(implied_title("nothing", "file-name.md"), "file-name");
    }

    #[test]
    fn identifiers_and_timestamps_come_from_what_the_caller_supplies() {
        let id = new_ulid(1_700_000_000_000.0, &[3; 10]).expect("ulid");
        assert!(is_ulid(&id), "{id}");
        assert_eq!(id, new_ulid(1_700_000_000_000.0, &[3; 16]).expect("ulid"));
        assert!(new_ulid(-1.0, &[0; 10]).is_err());
        assert!(new_ulid(f64::NAN, &[0; 10]).is_err());
        assert!(new_ulid(1.0, &[0; 9]).is_err());
        assert!(!is_ulid("01J8Z3K9T2V4W5X6Y7Z8A9B0C1"));

        assert_eq!(
            rfc3339_from_unix(0.0).as_deref(),
            Some("1970-01-01T00:00:00Z")
        );
        assert_eq!(rfc3339_from_unix(f64::NAN), None);
        assert!(is_rfc3339_utc("2026-01-01T00:00:00Z"));
        assert!(!is_rfc3339_utc("2026-01-01T00:00:00+02:00"));
        assert_eq!(format_version(), 1);
    }
}

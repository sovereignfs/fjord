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
//! time and the randomness (`crypto.getRandomValues`, `Date.now()`). The one exception is `age`, which draws
//! its own (the module's `getrandom` is the browser's or Node's `crypto.getRandomValues`): encrypting and
//! generating an identity.

use fjord_core::container;
use fjord_core::crypto;
use fjord_core::doc::{self, Parse};
use fjord_core::listing::{self, FileKind, ListedFile};
use fjord_core::manifest::{field, Manifest, Vaults};
use fjord_core::merge;
use fjord_core::naming::{self, LocalMinute};
use fjord_core::scaffold::{self, FileChange, Origin, Setup};
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

/// A document's text with its `title` set, or taken away if `title` is empty or only white space; every other key stays,
/// in its place (`fjord_core::doc::with_title`, spec §8.2). `None` for a text with no header to rewrite, and for one whose
/// header is broken, which is not ours to rewrite. Only the header is rewritten, by the YAML writer (so a title with a colon
/// or a quote reads back as it was, and comments in the header are lost); what follows the closing fence is as it was.
///
/// A client that keeps the header apart from the body passes the header alone and gets the header back.
pub fn with_title(text: &str, title: &str) -> Option<String> {
    let title = title.trim();
    doc::with_title(text, if title.is_empty() { None } else { Some(title) })
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

// --- Naming new files ---------------------------------------------------------------------------------

/// `["Notes.md", "Archive", …]` read: every entry of a folder, files and directories, with extensions.
fn names(json: &str) -> Result<Vec<String>, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|err| format!("the names are not JSON: {err}"))?;
    value
        .as_array()
        .ok_or("the names must be an array")?
        .iter()
        .map(|name| {
            name.as_str()
                .map(str::to_string)
                .ok_or_else(|| "a name must be text".to_string())
        })
        .collect()
}

/// The file name for a new note typed as `text` (`fjord_core::naming::quick_note_name`, the one every client uses):
/// named by its first line, with the Markdown that makes a line something other than a title stripped, cut at 60
/// characters, else by the date and time (`2026-10-22 1430`), and ` 2`, ` 3`, … if the folder already has it, case
/// aside. Ends in `.md` and is a valid name (spec §5).
///
/// - `existing_json`: `["a.md", "Archive", …]`, every entry of the folder.
/// - The last five are the writer's own local date and time, to the minute, for the fallback. Out of range is not
///   checked: the name is still a valid one, and a real date is the caller's to give.
pub fn quick_note_name(
    text: &str,
    existing_json: &str,
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
) -> Result<String, String> {
    let existing = names(existing_json)?;
    let now = LocalMinute {
        year,
        month,
        day,
        hour,
        minute,
    };
    Ok(naming::quick_note_name(text, &existing, now))
}

/// The name a text's first line asks for, without an extension, or `None` when there is nothing in it to name a file
/// by (empty, or only markers and punctuation). A document is named from its title this way, then given `.fj.md`.
pub fn title_from_text(text: &str) -> Option<String> {
    naming::title_from_text(text)
}

/// `stem` plus `extension`, or `stem 2`, `stem 3`, … plus `extension`: the first no entry of `existing_json` has, names
/// that differ only by case being the same name (spec §5 rule 6) and compared in NFC.
pub fn free_name(stem: &str, extension: &str, existing_json: &str) -> Result<String, String> {
    Ok(naming::free_name(stem, extension, &names(existing_json)?))
}

// --- Merging --------------------------------------------------------------------------------------------

/// Merge two edits of one text, `ours` and `theirs`, both made from `base` (spec §9.1; `fjord_core::merge::merge3`, the
/// merge `fjord sync` and the CLI use, so every client merges alike). By lines, as `git merge-file` does.
///
/// The answer is JSON: `{"clean": bool, "conflicts": number, "text": string}`. `text` is the merged text when `clean`;
/// otherwise it is the text with each conflict written between `<<<<<<< ours_label`, `=======` and
/// `>>>>>>> theirs_label` lines, for a person to settle. Neither side is ever dropped from it. A label is made safe to
/// put on a marker line (line breaks and control characters become spaces). Nothing is an error: any three texts merge.
pub fn merge_texts(
    base: &str,
    ours: &str,
    theirs: &str,
    ours_label: &str,
    theirs_label: &str,
) -> String {
    let merged = merge::merge3(base, ours, theirs);
    let text = merged
        .clean_text()
        .unwrap_or_else(|| merged.with_markers(&label(ours_label), &label(theirs_label)));
    json!({ "clean": merged.is_clean(), "conflicts": merged.conflicts(), "text": text }).to_string()
}

fn label(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

// --- Setting up a repository that is not a Fjord repository --------------------------------------------

/// What to add to a repository that is not a Fjord repository so that it is one (ROADMAP 1a.10): a
/// `fjord.json` and one plaintext vault, and nothing else but the line spec §9 requires of
/// `.gitattributes`. Nothing is changed, renamed or removed (`fjord_core::scaffold::plan_setup`).
///
/// - `options_json`: `{"repositoryName": string, "vault": string, "generator": string}`.
/// - `existing_json`: `{"paths": [string], "gitattributes": string | null}`: the path of every file in the
///   repository, and the text of its `.gitattributes` if it has one.
/// - `now_ms` and `random`: the time (milliseconds since the Unix epoch) and at least 80 random bytes,
///   which the identifiers and the creation time are made from. The same inputs give the same answer.
///
/// The answer is JSON. A finding about the repository is data: `{"ok": false, "error": {"code",
/// "message"}}` with the code one of `already_fjord`, `invalid_vault_name`, `vault_name_taken`,
/// `gitattributes_not_read`. Otherwise `{"ok": true, "files": [{"path", "contents", "change"}],
/// "repositoryId", "vaultId", "createdAt"}`, where `change` is `"create"`, or `"append"` for a
/// `.gitattributes` that already existed (its `contents` are the whole new file). `Err` is a malformed
/// call.
pub fn plan_setup(
    options_json: &str,
    existing_json: &str,
    now_ms: f64,
    random: &[u8],
) -> Result<String, String> {
    let options: Value = serde_json::from_str(options_json)
        .map_err(|err| format!("the options are not JSON: {err}"))?;
    let text = |key: &str| -> Result<String, String> {
        options
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("the options need a text `{key}`"))
    };
    let setup = Setup {
        repository_name: text("repositoryName")?,
        vault: text("vault")?,
        generator: text("generator")?,
    };

    let (paths, gitattributes) = existing(existing_json)?;

    if !now_ms.is_finite() || now_ms < 0.0 {
        return Err("the time must be milliseconds since the epoch, not negative".to_string());
    }
    let origin = Origin::from_entropy(now_ms as u64, random).ok_or_else(|| {
        format!(
            "a setup needs {} random bytes and a time that is a date",
            Origin::ENTROPY_BYTES
        )
    })?;

    Ok(
        match scaffold::plan_setup(&setup, &origin, &paths, gitattributes.as_deref()) {
            Ok(plan) => json!({
                "ok": true,
                "files": plan.files.iter().map(|file| json!({
                    "path": file.path,
                    "contents": file.contents,
                    "change": match file.change {
                        FileChange::Create => "create",
                        FileChange::Append => "append",
                    },
                })).collect::<Vec<_>>(),
                "repositoryId": plan.repository_id,
                "vaultId": plan.vault_id,
                "createdAt": plan.created_at,
            }),
            Err(error) => json!({
                "ok": false,
                "error": { "code": error.code(), "message": error.to_string() },
            }),
        }
        .to_string(),
    )
}

/// What to add to a Fjord repository for a new vault, plaintext or encrypted (ROADMAP 2d.1): the
/// vault's own files, `fjord.json` with the vault listed (every other field kept), and for an encrypted
/// vault spec §9's merge guard in `.gitattributes` if the repository lacks it. One planner for the CLI's
/// `fjord vault add` and the web client (`fjord_core::scaffold::plan_vault`), so they write the same bytes.
///
/// - `options_json`: `{"name": string, "encrypted": bool, "idNaming": bool, "recipients": [string]}`.
/// - `manifest`: the text of the repository's `fjord.json`.
/// - `existing_json`: as for [`plan_setup`].
/// - `now_ms` and `random`: the time and at least 16 random bytes, which the vault's identifier and
///   creation time are made from.
///
/// The answer is JSON: `{"ok": false, "error": {"code", "message"}}` for a finding (the code one of
/// `manifest_unusable`, `newer_version`, `invalid_name`, `name_taken`, `recipients_need_encryption`,
/// `id_naming_needs_encryption`, `bad_recipient`, `recipients_unsupported`, `gitattributes_not_read`),
/// else `{"ok": true, "files": [{"path", "contents", "change"}], "vaultId", "createdAt", "recipients"}`.
/// `Err` is a malformed call.
pub fn plan_vault(
    options_json: &str,
    manifest: &str,
    existing_json: &str,
    now_ms: f64,
    random: &[u8],
) -> Result<String, String> {
    let options: Value = serde_json::from_str(options_json)
        .map_err(|err| format!("the options are not JSON: {err}"))?;
    let name = options
        .get("name")
        .and_then(Value::as_str)
        .ok_or("the options need a text `name`")?
        .to_string();
    let flag = |key: &str| -> Result<bool, String> {
        match options.get(key) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(value)) => Ok(*value),
            Some(_) => Err(format!("`{key}` must be true or false")),
        }
    };
    let recipients = match options.get("recipients") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or("a recipient must be text")
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("`recipients` must be a list".to_string()),
    };
    let setup = scaffold::VaultSetup {
        name,
        encrypted: flag("encrypted")?,
        id_naming: flag("idNaming")?,
        recipients,
    };

    let (paths, gitattributes) = existing(existing_json)?;

    if !now_ms.is_finite() || now_ms < 0.0 {
        return Err("the time must be milliseconds since the epoch, not negative".to_string());
    }
    if random.len() < 16 {
        return Err("a vault needs 16 random bytes".to_string());
    }
    let mut entropy = [0u8; 16];
    entropy.copy_from_slice(&random[..16]);
    let created_at = scalar::rfc3339_utc_from_unix((now_ms / 1000.0) as i64)
        .ok_or("the time cannot be written as a date")?;
    let vault_id = scalar::new_ulid_from(now_ms as u64, entropy);

    Ok(match scaffold::plan_vault(
        &setup,
        manifest.as_bytes(),
        &paths,
        gitattributes.as_deref(),
        &vault_id,
        &created_at,
    ) {
        Ok(plan) => json!({
            "ok": true,
            "files": plan.files.iter().map(|file| json!({
                "path": file.path,
                "contents": file.contents,
                "change": match file.change {
                    FileChange::Create => "create",
                    FileChange::Append => "append",
                },
            })).collect::<Vec<_>>(),
            "vaultId": plan.vault_id,
            "createdAt": plan.created_at,
            "recipients": plan.recipients,
        }),
        Err(error) => json!({
            "ok": false,
            "error": { "code": error.code(), "message": error.to_string() },
        }),
    }
    .to_string())
}

/// A vault name that is free at the root of a repository (`"Public"`, else `"Public 2"`, …).
/// `existing_json` is as for [`plan_setup`]; only its `paths` are looked at.
pub fn free_vault_name(preferred: &str, existing_json: &str) -> Result<String, String> {
    let (paths, _) = existing(existing_json)?;
    Ok(scaffold::free_vault_name(preferred, &paths))
}

/// `{"paths": [...], "gitattributes": string | null}`, read.
fn existing(json: &str) -> Result<(Vec<String>, Option<String>), String> {
    let value: Value =
        serde_json::from_str(json).map_err(|err| format!("the repository is not JSON: {err}"))?;
    let paths = value
        .get("paths")
        .and_then(Value::as_array)
        .ok_or("the repository needs a list of `paths`")?
        .iter()
        .map(|path| {
            path.as_str()
                .map(str::to_string)
                .ok_or("a path must be text")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let gitattributes = match value.get("gitattributes") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return Err("`gitattributes` must be text or null".to_string()),
    };
    Ok((paths, gitattributes))
}

// --- Encryption (ROADMAP web P8) -------------------------------------------
//
// Secrets are bytes, not strings, so that the page can wipe them (`fill(0)`) when it is done. The module wipes what it
// holds (`Zeroizing`); what it hands back is the caller's to wipe.

/// A new X25519 identity: its `AGE-SECRET-KEY-1…` line, as bytes.
pub fn generate_identity() -> Vec<u8> {
    crypto::generate_identity().secret.as_bytes().to_vec()
}

/// The `age1…` public key for the identity (a secret-key line, or an identity file's text), as bytes the caller owns.
pub fn identity_recipient(identity: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(identity).map_err(|_| "the identity is not text".to_string())?;
    crypto::recipient_of(text).map_err(|error| error.to_string())
}

/// Why a recipient line cannot be used, or `None` if it can. The reasons are for a person.
pub fn check_recipient(text: &str) -> Option<String> {
    crypto::check_recipient(text).err()
}

/// Whether the bytes begin a well-formed age payload (binary or armored); needs no key.
pub fn is_well_formed(bytes: &[u8]) -> bool {
    crypto::is_well_formed(bytes)
}

/// Encrypt to every recipient in a recipients file's text. A file with none is refused, never encrypted to nobody.
pub fn encrypt(plaintext: &[u8], recipients: &str, armor: bool) -> Result<Vec<u8>, String> {
    let recipients = crypto::parse_recipients(recipients).map_err(|error| error.to_string())?;
    crypto::encrypt(plaintext, &recipients, armor).map_err(|error| error.to_string())
}

/// Decrypt a payload (binary or armored) with an identity: a secret-key line, or an identity file's text.
pub fn decrypt(ciphertext: &[u8], identity: &[u8]) -> Result<Vec<u8>, String> {
    let text = zeroize::Zeroizing::new(
        std::str::from_utf8(identity)
            .map_err(|_| "the identity is not text".to_string())?
            .to_string(),
    );
    let identities = crypto::parse_identities(&text).map_err(|error| error.to_string())?;
    let plaintext = crypto::decrypt(ciphertext, &identities).map_err(|error| error.to_string())?;
    Ok(plaintext.to_vec())
}

/// scrypt's `log2(N)` for sealing a secret with a passphrase: what a page passes unless it has a reason not to.
pub fn passphrase_work_factor() -> u8 {
    crypto::PASSPHRASE_WORK_FACTOR
}

/// Seal bytes (an identity) with a passphrase, as `age -p` would, to keep it at rest. Not a vault recipient (spec §6.2).
pub fn seal_with_passphrase(
    plaintext: &[u8],
    passphrase: &[u8],
    log_n: u8,
) -> Result<Vec<u8>, String> {
    let passphrase = zeroize::Zeroizing::new(
        std::str::from_utf8(passphrase)
            .map_err(|_| "the passphrase is not text".to_string())?
            .to_string(),
    );
    crypto::seal_with_passphrase(plaintext, &passphrase, log_n).map_err(|error| error.to_string())
}

/// Open what [`seal_with_passphrase`] made. A wrong passphrase, and a file that asks for too much work, are refused.
pub fn open_with_passphrase(sealed: &[u8], passphrase: &[u8]) -> Result<Vec<u8>, String> {
    let passphrase = zeroize::Zeroizing::new(
        std::str::from_utf8(passphrase)
            .map_err(|_| "the passphrase is not text".to_string())?
            .to_string(),
    );
    let opened =
        crypto::open_with_passphrase(sealed, &passphrase).map_err(|error| error.to_string())?;
    Ok(opened.to_vec())
}

/// Pack one file in the single-entry tar container of an `id`-named vault (spec §6.4).
pub fn wrap_container(name: &str, contents: &[u8]) -> Result<Vec<u8>, String> {
    container::wrap(name, contents).map_err(|error| error.to_string())
}

/// Read a container, refusing everything spec §6.4 says to: not one regular file, a name with a path.
pub fn unwrap_container(archive: &[u8]) -> Result<(String, Vec<u8>), String> {
    let unwrapped = container::unwrap(archive).map_err(|error| error.to_string())?;
    Ok((unwrapped.name, unwrapped.contents))
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

    // --- Setting up a repository ---

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len() / 2)
            .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect()
    }

    /// The recorded cases of `tests/fixtures/setup.json`: what `plan_setup` answers for each input. The
    /// JavaScript suite holds the built module to the same file, so the module and the Rust agree.
    fn recorded() -> Vec<Value> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/setup.json");
        let text = std::fs::read_to_string(path).expect("setup.json");
        serde_json::from_str::<Vec<Value>>(&text).expect("an array of cases")
    }

    fn answer(case: &Value) -> Value {
        let random = hex(case["randomHex"].as_str().expect("randomHex"));
        let text = plan_setup(
            &case["options"].to_string(),
            &case["existing"].to_string(),
            case["nowMs"].as_f64().expect("nowMs"),
            &random,
        )
        .expect("a well-formed call");
        parsed(&text)
    }

    #[test]
    fn the_recorded_setups_are_what_it_answers() {
        let cases = recorded();
        assert!(cases.len() >= 8, "only {} cases", cases.len());
        for case in cases {
            assert_eq!(answer(&case), case["expected"], "{}", case["name"]);
        }
    }

    /// Re-record `tests/fixtures/setup.json` after a deliberate change to what a setup writes:
    /// `cargo test -p fjord-wasm record_the_setups -- --ignored`, then read the diff.
    #[test]
    #[ignore = "writes tests/fixtures/setup.json"]
    fn record_the_setups() {
        let mut cases = recorded();
        for case in &mut cases {
            let expected = answer(case);
            case["expected"] = expected;
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/setup.json");
        let text = serde_json::to_string_pretty(&cases).expect("JSON");
        std::fs::write(path, format!("{text}\n")).expect("write");
    }

    fn recorded_vaults() -> Vec<Value> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/vault.json");
        let text = std::fs::read_to_string(path).expect("vault.json");
        serde_json::from_str::<Vec<Value>>(&text).expect("an array of cases")
    }

    fn vault_answer(case: &Value) -> Value {
        let random = hex(case["randomHex"].as_str().expect("randomHex"));
        let text = plan_vault(
            &case["options"].to_string(),
            case["manifest"].as_str().expect("manifest"),
            &case["existing"].to_string(),
            case["nowMs"].as_f64().expect("nowMs"),
            &random,
        )
        .expect("a well-formed call");
        parsed(&text)
    }

    #[test]
    fn the_recorded_vaults_are_what_it_answers() {
        let cases = recorded_vaults();
        assert!(cases.len() >= 12, "only {} cases", cases.len());
        for case in cases {
            assert_eq!(vault_answer(&case), case["expected"], "{}", case["name"]);
        }
    }

    /// Re-record `tests/fixtures/vault.json` after a deliberate change to what a new vault writes:
    /// `cargo test -p fjord-wasm record_the_vaults -- --ignored`, then read the diff.
    #[test]
    #[ignore = "writes tests/fixtures/vault.json"]
    fn record_the_vaults() {
        let mut cases = recorded_vaults();
        for case in &mut cases {
            let expected = vault_answer(case);
            case["expected"] = expected;
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/vault.json");
        let text = serde_json::to_string_pretty(&cases).expect("JSON");
        std::fs::write(path, format!("{text}\n")).expect("write");
    }

    #[test]
    fn a_malformed_vault_call_is_an_error_and_not_a_finding() {
        let existing = r#"{"paths":["fjord.json"],"gitattributes":null}"#;
        let manifest = r#"{"fjord":1}"#;
        let random = vec![7u8; 16];
        assert!(plan_vault(r#"{"name":"V"}"#, manifest, existing, 1.0e12, &random).is_ok());
        for (options, existing, now, random) in [
            ("not json", existing, 1.0e12, &random[..]),
            (r#"{}"#, existing, 1.0e12, &random[..]),
            (r#"{"name":3}"#, existing, 1.0e12, &random[..]),
            (
                r#"{"name":"V","encrypted":"yes"}"#,
                existing,
                1.0e12,
                &random[..],
            ),
            (
                r#"{"name":"V","recipients":"age1"}"#,
                existing,
                1.0e12,
                &random[..],
            ),
            (
                r#"{"name":"V","recipients":[1]}"#,
                existing,
                1.0e12,
                &random[..],
            ),
            (r#"{"name":"V"}"#, "not json", 1.0e12, &random[..]),
            (r#"{"name":"V"}"#, existing, f64::NAN, &random[..]),
            (r#"{"name":"V"}"#, existing, -1.0, &random[..]),
            (r#"{"name":"V"}"#, existing, 1.0e12, &random[..15]),
        ] {
            assert!(
                plan_vault(options, manifest, existing, now, random).is_err(),
                "{options} {existing} {now}"
            );
        }
    }

    #[test]
    fn a_malformed_call_is_an_error_and_not_a_finding() {
        let ok_options = r#"{"repositoryName":"r","vault":"V","generator":"g"}"#;
        let ok_existing = r#"{"paths":[],"gitattributes":null}"#;
        let random = vec![7u8; 80];
        assert!(plan_setup(ok_options, ok_existing, 1.0e12, &random).is_ok());

        for (options, existing, now, random) in [
            ("not json", ok_existing, 1.0e12, &random[..]),
            (
                r#"{"vault":"V","generator":"g"}"#,
                ok_existing,
                1.0e12,
                &random[..],
            ),
            (
                r#"{"repositoryName":"r","vault":3,"generator":"g"}"#,
                ok_existing,
                1.0e12,
                &random[..],
            ),
            (ok_options, "not json", 1.0e12, &random[..]),
            (ok_options, r#"{"gitattributes":null}"#, 1.0e12, &random[..]),
            (ok_options, r#"{"paths":[1]}"#, 1.0e12, &random[..]),
            (
                ok_options,
                r#"{"paths":[],"gitattributes":3}"#,
                1.0e12,
                &random[..],
            ),
            (ok_options, ok_existing, f64::NAN, &random[..]),
            (ok_options, ok_existing, -1.0, &random[..]),
            (ok_options, ok_existing, 1.0e12, &random[..79]),
        ] {
            assert!(
                plan_setup(options, existing, now, random).is_err(),
                "{options} {existing} {now}"
            );
        }
    }

    #[test]
    fn a_title_is_set_trimmed_and_taken_away_when_there_is_none() {
        let text = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntitle: Old\nx: 1\n---\nbody\n";
        let set = with_title(text, "  New  ").expect("a rewrite");
        let parsed = parsed(&parse_document(&set));
        assert_eq!(parsed["title"], json!("New"));
        assert_eq!(parsed["docId"], json!("01jagc4k7pt8y3wqnmzv5xrb7h"));
        assert_eq!(parsed["frontmatter"]["x"], json!(1));
        assert!(set.ends_with("---\nbody\n"));

        for none in ["", "   ", "\t\n"] {
            let taken = with_title(text, none).expect("a rewrite");
            assert!(parsed_of(&taken).get("title").is_none(), "{none:?}");
        }
        assert_eq!(with_title("no header\n", "T"), None);
        assert_eq!(with_title("---\nnever closed\n", "T"), None);
        // The header alone, as a client that keeps it apart sends it, comes back alone.
        let header = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\n---\n";
        let only = with_title(header, "T").expect("a rewrite");
        let body_offset = parsed_of_value(&only)["bodyOffset"]
            .as_u64()
            .expect("an offset") as usize;
        assert_eq!(body_offset, only.len());
    }

    fn parsed_of(text: &str) -> serde_json::Map<String, Value> {
        parsed(&parse_document(text))["frontmatter"]
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    fn parsed_of_value(text: &str) -> Value {
        parsed(&parse_document(text))
    }

    #[test]
    fn a_new_note_is_named_by_its_first_line_and_then_by_the_time() {
        let name = |text: &str, existing: &str| {
            quick_note_name(text, existing, 2026, 10, 22, 14, 30).expect("name")
        };
        assert_eq!(name("# Meeting notes\n\nbody", "[]"), "Meeting notes.md");
        assert_eq!(name("- [ ] Buy milk", "[]"), "Buy milk.md");
        assert_eq!(name("", "[]"), "2026-10-22 1430.md");
        assert_eq!(name("---", "[]"), "2026-10-22 1430.md");
        assert_eq!(name("a/b: c?", "[]"), "a b c.md");
        assert_eq!(name("CON", "[]"), "Note CON.md");
        assert_eq!(
            name("Plan", r#"["Plan.md", "PLAN 2.md", "Archive"]"#),
            "Plan 3.md",
            "case aside, and numbered past what is taken"
        );
        assert_eq!(name("Archive", r#"["Archive"]"#), "Archive.md");
        assert!(quick_note_name("x", "{}", 2026, 1, 1, 0, 0).is_err());
        assert!(quick_note_name("x", "[1]", 2026, 1, 1, 0, 0).is_err());
    }

    #[test]
    fn a_title_names_a_file_and_a_free_name_is_numbered() {
        assert_eq!(
            title_from_text("# Q4 plan\nmore").as_deref(),
            Some("Q4 plan")
        );
        assert_eq!(title_from_text("***"), None);
        assert_eq!(title_from_text(""), None);
        assert_eq!(
            free_name("Q4 plan", ".fj.md", r#"["q4 plan.fj.md"]"#).expect("name"),
            "Q4 plan 2.fj.md"
        );
        assert_eq!(
            free_name("Q4 plan", ".fj.md", r#"["Q4 plan.md"]"#).expect("name"),
            "Q4 plan.fj.md",
            "a note of that name does not take a document's"
        );
        assert!(free_name("x", ".md", "nope").is_err());
    }

    #[test]
    fn two_edits_in_different_places_merge_cleanly() {
        let merged = parsed(&merge_texts(
            "one\ntwo\nthree\nfour\nfive\n",
            "ONE\ntwo\nthree\nfour\nfive\n",
            "one\ntwo\nthree\nfour\nFIVE\n",
            "mine",
            "theirs",
        ));
        assert_eq!(
            merged,
            json!({ "clean": true, "conflicts": 0, "text": "ONE\ntwo\nthree\nfour\nFIVE\n" })
        );
    }

    #[test]
    fn two_edits_of_the_same_line_conflict_and_both_are_kept_between_markers() {
        let merged = parsed(&merge_texts(
            "a\nsame\nz\n",
            "a\nmine\nz\n",
            "a\ntheirs\nz\n",
            "Your changes",
            "In the repository",
        ));
        assert_eq!(merged["clean"], json!(false));
        assert_eq!(merged["conflicts"], json!(1));
        assert_eq!(
            merged["text"],
            json!("a\n<<<<<<< Your changes\nmine\n=======\ntheirs\n>>>>>>> In the repository\nz\n")
        );
    }

    #[test]
    fn a_side_that_changed_nothing_gives_way_to_the_other() {
        let same = |text: &str| parsed(text)["text"].as_str().map(str::to_string);
        assert_eq!(
            same(&merge_texts("b\n", "b\n", "t\n", "m", "t")),
            Some("t\n".to_string())
        );
        assert_eq!(
            same(&merge_texts("b\n", "m\n", "b\n", "m", "t")),
            Some("m\n".to_string())
        );
        assert_eq!(
            same(&merge_texts("b\n", "x\n", "x\n", "m", "t")),
            Some("x\n".to_string())
        );
    }

    #[test]
    fn a_missing_final_newline_and_a_byte_order_mark_are_kept_as_text() {
        let merged = parsed(&merge_texts(
            "\u{feff}a\r\nb",
            "\u{feff}a\r\nb\r\nc",
            "\u{feff}A\r\nb",
            "m",
            "t",
        ));
        assert_eq!(
            merged["clean"],
            json!(false),
            "touching changes are one region"
        );
        let clean = parsed(&merge_texts(
            "a\r\nb\r\nc\r\nd",
            "A\r\nb\r\nc\r\nd",
            "a\r\nb\r\nc\r\nD",
            "m",
            "t",
        ));
        assert_eq!(clean["text"], json!("A\r\nb\r\nc\r\nD"));
    }

    #[test]
    fn a_label_cannot_break_a_marker_line() {
        let merged = parsed(&merge_texts(
            "x\n",
            "m\n",
            "t\n",
            "mine\n=======\nevil",
            "  th\u{7}eirs ",
        ));
        let text = merged["text"].as_str().expect("text");
        assert!(
            text.starts_with("<<<<<<< mine ======= evil\nm\n=======\nt\n>>>>>>> th eirs\n"),
            "{text}"
        );
    }

    #[test]
    fn a_free_vault_name_comes_from_the_paths() {
        assert_eq!(
            free_vault_name("Public", r#"{"paths":["README.md"]}"#).expect("name"),
            "Public"
        );
        assert_eq!(
            free_vault_name("Public", r#"{"paths":["public/a.md"]}"#).expect("name"),
            "Public 2"
        );
        assert!(free_vault_name("Public", "nope").is_err());
    }

    // --- Encryption ---

    #[test]
    fn an_identity_encrypts_and_decrypts_and_names_its_recipient() {
        let identity = generate_identity();
        assert!(identity.starts_with(b"AGE-SECRET-KEY-1"));
        let recipient = identity_recipient(&identity).unwrap();
        assert!(recipient.starts_with("age1"));
        assert_eq!(check_recipient(&recipient), None);

        let sealed = encrypt(
            b"hello \xf0\x9f\x92\xa7",
            &format!("# a comment\n{recipient}\n"),
            false,
        )
        .unwrap();
        assert!(is_well_formed(&sealed));
        assert!(!sealed.windows(5).any(|window| window == b"hello"));
        assert_eq!(
            decrypt(&sealed, &identity).unwrap(),
            "hello \u{1f4a7}".as_bytes()
        );

        let armored = encrypt(b"x", &recipient, true).unwrap();
        assert!(armored.starts_with(b"-----BEGIN AGE ENCRYPTED FILE-----"));
        assert_eq!(decrypt(&armored, &identity).unwrap(), b"x");
    }

    #[test]
    fn an_identity_file_with_comments_works_as_the_secret() {
        let identity = generate_identity();
        let recipient = identity_recipient(&identity).unwrap();
        let file = format!(
            "# created: now\n# public key: {recipient}\n{}\n",
            std::str::from_utf8(&identity).unwrap()
        );
        assert_eq!(identity_recipient(file.as_bytes()).unwrap(), recipient);
        let sealed = encrypt(b"x", &recipient, false).unwrap();
        assert_eq!(decrypt(&sealed, file.as_bytes()).unwrap(), b"x");
    }

    #[test]
    fn the_wrong_identity_and_no_recipients_are_refused() {
        let (mine, theirs) = (generate_identity(), generate_identity());
        let sealed = encrypt(b"secret", &identity_recipient(&mine).unwrap(), false).unwrap();
        assert!(decrypt(&sealed, &theirs).is_err());
        assert!(decrypt(&sealed, b"not an identity").is_err());
        assert!(decrypt(&sealed, &[0xff, 0xfe])
            .unwrap_err()
            .contains("not text"));
        assert!(encrypt(b"x", "# only a comment\n", false).is_err());
        assert!(!is_well_formed(b"plain text"));
    }

    #[test]
    fn a_recipient_that_cannot_be_used_says_why() {
        assert!(check_recipient("age1nope")
            .unwrap()
            .contains("age public key"));
        let secret = String::from_utf8(generate_identity()).unwrap();
        assert!(check_recipient(&secret).unwrap().contains("secret key"));
        assert!(check_recipient("# comment").is_some());
    }

    #[test]
    fn an_identity_is_sealed_with_a_passphrase_and_opened_with_it() {
        let identity = generate_identity();
        let sealed = seal_with_passphrase(&identity, "a long passphrase".as_bytes(), 10).unwrap();
        assert_eq!(
            open_with_passphrase(&sealed, b"a long passphrase").unwrap(),
            identity
        );
        assert!(open_with_passphrase(&sealed, b"another one").is_err());
        assert!(seal_with_passphrase(&identity, b"", 10).is_err());
        assert!(open_with_passphrase(&sealed, &[0xff])
            .unwrap_err()
            .contains("not text"));
        assert_eq!(passphrase_work_factor(), 18);
    }

    #[test]
    fn the_container_round_trips_and_refuses_a_name_with_a_path() {
        let archive = wrap_container("01j8z3k9t2v4w5x6y7z8a9b0c1.md", b"# Title\n").unwrap();
        assert_eq!(
            unwrap_container(&archive).unwrap(),
            (
                "01j8z3k9t2v4w5x6y7z8a9b0c1.md".to_string(),
                b"# Title\n".to_vec()
            )
        );
        assert!(wrap_container("dir/name.md", b"x").is_err());
        assert!(wrap_container("../name.md", b"x").is_err());
        assert!(unwrap_container(b"not a tar").is_err());
    }
}

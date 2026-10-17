// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord.json` and `fjord.vault.json`. Spec §3, §4.
//!
//! # Why this is a map and not a struct
//!
//! Both manifests are parsed into an ordered JSON map and read through
//! accessors, rather than deserialised into a struct of typed fields. Two
//! reasons, both load-bearing:
//!
//! 1. **Diagnostic precision.** A struct with `id: Ulid` turns a malformed
//!    identifier into a deserialisation failure, which can only be reported
//!    as [`Code::ManifestUnparseable`] — "fjord.json is not valid JSON",
//!    which is both wrong and unhelpful. Keeping every field untyped until
//!    it is checked lets a missing field be
//!    [`Code::RequiredFieldMissing`], a malformed ULID be
//!    [`Code::InvalidUlid`], and a genuinely broken file be
//!    [`Code::ManifestUnparseable`].
//!
//! 2. **Unknown fields survive.** Invariant 3 and spec §10.1 require that
//!    rewriting a manifest written by a newer client loses nothing. Holding
//!    the parsed map *is* the preservation mechanism — unknown keys, their
//!    order, and unknown nested structure are all still there, with no
//!    `#[serde(flatten)]` catch-all to get subtly wrong.
//!
//! [`Code::ManifestUnparseable`]: crate::diagnostics::Code::ManifestUnparseable
//! [`Code::RequiredFieldMissing`]: crate::diagnostics::Code::RequiredFieldMissing
//! [`Code::InvalidUlid`]: crate::diagnostics::Code::InvalidUlid

use serde_json::{Map, Value};

/// Field names the specification fixes, so that a typo in this crate is a
/// compile error rather than a check that silently never fires.
pub mod field {
    pub const FJORD: &str = "fjord";
    pub const ID: &str = "id";
    pub const NAME: &str = "name";
    pub const CREATED_AT: &str = "createdAt";
    pub const GENERATOR: &str = "generator";
    pub const VAULTS: &str = "vaults";
    pub const PATH: &str = "path";
    pub const ENCRYPTION: &str = "encryption";
    pub const FILE_NAMING: &str = "fileNaming";
    pub const TOOL: &str = "tool";
    pub const RECIPIENTS: &str = "recipients";
    pub const SUFFIX: &str = "suffix";
    pub const CONTAINER: &str = "container";
    pub const ARMOR: &str = "armor";
}

/// Required fields of `fjord.json`. Spec §3.
pub const REPOSITORY_REQUIRED: &[&str] = &[
    field::FJORD,
    field::ID,
    field::NAME,
    field::CREATED_AT,
    field::VAULTS,
];

/// Required fields of `fjord.vault.json`. Spec §4.
pub const VAULT_REQUIRED: &[&str] = &[
    field::FJORD,
    field::ID,
    field::NAME,
    field::CREATED_AT,
    field::ENCRYPTION,
    field::FILE_NAMING,
];

/// Required fields of a vault's `encryption` object. Spec §4.1.
pub const ENCRYPTION_REQUIRED: &[&str] = &[
    field::TOOL,
    field::RECIPIENTS,
    field::SUFFIX,
    field::CONTAINER,
    field::ARMOR,
];

/// The only encryption tool version 1 permits. Spec §4.1.
pub const TOOL_AGE: &str = "age";

/// The only suffix version 1 permits. Spec §4.1.
pub const SUFFIX_AGE: &str = ".age";

/// The recipients file name `fjord init` writes. Not a default: §4.1 makes
/// `encryption.recipients` required, so a vault that omits it is in error
/// rather than falling back to this.
pub const CONVENTIONAL_RECIPIENTS_FILE: &str = "recipients.txt";

/// Why a manifest could not be parsed at all.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    /// Not well-formed JSON. Carries the parser's own message, which names
    /// the line and column.
    #[error("{0}")]
    Json(String),
    /// Well-formed JSON, but not an object — a manifest that is an array or
    /// a bare string cannot have fields checked.
    #[error("top-level value is not a JSON object")]
    NotAnObject,
}

/// A parsed manifest.
///
/// One type backs both `fjord.json` and `fjord.vault.json`: they share every
/// field but `vaults` and `encryption`, and keeping one type means the
/// shared checks cannot drift apart.
#[derive(Debug, Clone)]
pub struct Manifest {
    raw: Map<String, Value>,
}

impl Manifest {
    /// Parse manifest bytes.
    ///
    /// A UTF-8 byte-order mark is a parse failure, which is correct: §3
    /// requires UTF-8 with no BOM.
    pub fn parse(bytes: &[u8]) -> Result<Self, ParseError> {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|err| ParseError::Json(err.to_string()))?;
        match value {
            Value::Object(raw) => Ok(Self { raw }),
            _ => Err(ParseError::NotAnObject),
        }
    }

    /// The manifest exactly as parsed. This is what a rewrite must preserve.
    pub fn raw(&self) -> &Map<String, Value> {
        &self.raw
    }

    /// Whether a key is present, regardless of its value. A key present and
    /// `null` counts as present — which matters for `encryption`, where
    /// `null` is a meaningful value and absence is an error.
    pub fn has(&self, key: &str) -> bool {
        self.raw.contains_key(key)
    }

    /// A field's value as a string, or `None` if absent or another type.
    pub fn string(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(Value::as_str)
    }

    /// The declared format version. Spec §3, §10.1.
    pub fn version(&self) -> Option<i64> {
        self.raw.get(field::FJORD).and_then(Value::as_i64)
    }

    /// `fileNaming`. Spec §7.
    pub fn file_naming(&self) -> Option<&str> {
        self.string(field::FILE_NAMING)
    }

    /// The `vaults` array of `fjord.json`. Spec §3.
    pub fn vaults(&self) -> Vaults {
        match self.raw.get(field::VAULTS) {
            None => Vaults::Absent,
            Some(Value::Array(items)) => Vaults::Entries(
                items
                    .iter()
                    .map(|item| match item {
                        Value::Object(map) => VaultEntry {
                            path: map
                                .get(field::PATH)
                                .and_then(Value::as_str)
                                .map(String::from),
                            id: map.get(field::ID).and_then(Value::as_str).map(String::from),
                        },
                        // Not an object, so it declares neither field. The
                        // caller reports the missing `path` rather than a
                        // parse failure, so one malformed entry does not
                        // hide the rest of the manifest.
                        _ => VaultEntry {
                            path: None,
                            id: None,
                        },
                    })
                    .collect(),
            ),
            Some(_) => Vaults::NotAnArray,
        }
    }

    /// The `encryption` field of `fjord.vault.json`. Spec §4, §4.1.
    pub fn encryption(&self) -> EncryptionField<'_> {
        match self.raw.get(field::ENCRYPTION) {
            None => EncryptionField::Absent,
            Some(Value::Null) => EncryptionField::Null,
            Some(Value::Object(map)) => EncryptionField::Object(map),
            Some(_) => EncryptionField::NotAnObject,
        }
    }

    /// Whether this vault is encrypted. A malformed `encryption` field is
    /// not encrypted *as far as reading goes*, but the caller will already
    /// have reported it.
    pub fn is_encrypted(&self) -> bool {
        matches!(self.encryption(), EncryptionField::Object(_))
    }
}

/// The state of `fjord.json`'s `vaults` field.
#[derive(Debug, Clone)]
pub enum Vaults {
    /// The field is missing: [`Code::RequiredFieldMissing`][c].
    ///
    /// [c]: crate::diagnostics::Code::RequiredFieldMissing
    Absent,
    /// Present but not an array.
    NotAnArray,
    /// Present and an array, whose entries may still be incomplete.
    Entries(Vec<VaultEntry>),
}

/// One entry of `fjord.json`'s `vaults` array. Spec §3.
#[derive(Debug, Clone)]
pub struct VaultEntry {
    /// Repository-relative directory. Validated by
    /// [`crate::path::check_manifest_path`].
    pub path: Option<String>,
    /// MUST match the vault's own `id`. Spec §3, §4.
    pub id: Option<String>,
}

/// The state of `fjord.vault.json`'s `encryption` field. Spec §4.
///
/// `null` and absent are distinct: `null` declares a plaintext vault, while
/// absence is a missing required field.
#[derive(Debug, Clone)]
pub enum EncryptionField<'a> {
    Absent,
    /// An explicitly plaintext vault.
    Null,
    Object(&'a Map<String, Value>),
    NotAnObject,
}

/// A string field of a nested object, such as `encryption.tool`.
pub fn object_string<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// Whether a nested object has a key, regardless of its value.
pub fn object_has(map: &Map<String, Value>, key: &str) -> bool {
    map.contains_key(key)
}

// --- Recipients ----------------------------------------------------------

/// What one line of a recipients file declares. Spec §6.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientKind {
    /// An `age1…` X25519 recipient: the form §6.2 requires.
    X25519,
    /// An `ssh-ed25519` or `ssh-rsa` recipient, which §6.2 permits.
    Ssh,
    /// A passphrase recipient, which §6.2 forbids.
    Passphrase,
    /// Neither a comment nor a recipient this crate recognises.
    Malformed,
}

/// One significant line of a recipients file.
#[derive(Debug, Clone)]
pub struct RecipientLine {
    /// 1-based, so it can be reported to a user as an editor would show it.
    pub number: usize,
    pub kind: RecipientKind,
    pub text: String,
}

/// bech32's character set, which excludes `1`, `b`, `i` and `o`.
const BECH32: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// Total length of an `age1…` X25519 recipient: `age1` plus 58 data
/// characters.
const X25519_LENGTH: usize = 62;

/// Classify one line. `None` for a blank line or a comment, both of which
/// §6.2 says MUST be ignored.
pub fn classify_recipient(line: &str) -> Option<RecipientKind> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    if trimmed.starts_with("ssh-ed25519 ") || trimmed.starts_with("ssh-rsa ") {
        return Some(RecipientKind::Ssh);
    }

    // age has no textual form for a passphrase recipient: `age -p` is a
    // command-line choice, and `scrypt` is the stanza it writes into the
    // file header. A recipients file naming either is asking for the one
    // thing §6.2 forbids, and saying so is far more useful than reporting a
    // malformed line.
    let lowered = trimmed.to_lowercase();
    if lowered == "passphrase"
        || lowered.starts_with("passphrase:")
        || lowered.starts_with("scrypt")
    {
        return Some(RecipientKind::Passphrase);
    }

    if let Some(data) = trimmed.strip_prefix("age1") {
        let well_formed =
            trimmed.len() == X25519_LENGTH && data.bytes().all(|byte| BECH32.contains(&byte));
        if well_formed {
            return Some(RecipientKind::X25519);
        }
    }

    Some(RecipientKind::Malformed)
}

/// Classify every significant line of a recipients file. Spec §6.2.
pub fn parse_recipients(text: &str) -> Vec<RecipientLine> {
    text.lines()
        .enumerate()
        .filter_map(|(index, line)| {
            classify_recipient(line).map(|kind| RecipientLine {
                number: index + 1,
                kind,
                text: line.trim().to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPOSITORY: &str = r#"{
      "fjord": 1,
      "id": "01jagc4k7pqw2xn8rvty5zb3md",
      "name": "Fjord",
      "createdAt": "2026-10-16T09:34:00Z",
      "unknownToThisVersion": { "b": 2, "a": 1 },
      "vaults": [{ "path": "Public", "id": "01jagc4k7pr9tbm3ykwx6zq2hv" }]
    }"#;

    #[test]
    fn reads_the_fields_the_spec_fixes() {
        let manifest = match Manifest::parse(REPOSITORY.as_bytes()) {
            Ok(manifest) => manifest,
            Err(err) => panic!("conforming manifest did not parse: {err}"),
        };
        assert_eq!(manifest.version(), Some(1));
        assert_eq!(
            manifest.string(field::ID),
            Some("01jagc4k7pqw2xn8rvty5zb3md")
        );
        assert_eq!(manifest.string(field::NAME), Some("Fjord"));
        assert!(manifest.has(field::CREATED_AT));
        assert!(!manifest.has(field::GENERATOR));
    }

    /// Invariant 3: a manifest written by a newer client round-trips.
    #[test]
    fn unknown_fields_and_their_order_survive() {
        let manifest = match Manifest::parse(REPOSITORY.as_bytes()) {
            Ok(manifest) => manifest,
            Err(err) => panic!("{err}"),
        };
        let unknown = match manifest.raw().get("unknownToThisVersion") {
            Some(Value::Object(map)) => map,
            other => panic!("unknown field was dropped: {other:?}"),
        };
        // `preserve_order` keeps the document's order, not alphabetical.
        let keys: Vec<&String> = unknown.keys().collect();
        assert_eq!(keys, vec!["b", "a"]);

        let round_tripped = match serde_json::to_string(manifest.raw()) {
            Ok(text) => text,
            Err(err) => panic!("{err}"),
        };
        assert!(round_tripped.contains("unknownToThisVersion"));
        assert!(round_tripped.contains(r#""b":2,"a":1"#));
    }

    #[test]
    fn a_missing_field_is_not_a_parse_failure() {
        // The whole point of the map representation: this parses, so the
        // caller can report precisely which field is absent.
        let manifest = match Manifest::parse(br#"{"fjord": 1}"#) {
            Ok(manifest) => manifest,
            Err(err) => panic!("{err}"),
        };
        assert!(!manifest.has(field::ID));
        assert!(matches!(manifest.vaults(), Vaults::Absent));
    }

    #[test]
    fn a_malformed_ulid_is_not_a_parse_failure() {
        let manifest = match Manifest::parse(br#"{"id": "nope"}"#) {
            Ok(manifest) => manifest,
            Err(err) => panic!("{err}"),
        };
        assert_eq!(manifest.string(field::ID), Some("nope"));
    }

    #[test]
    fn rejects_json_that_is_not_an_object() {
        assert!(matches!(
            Manifest::parse(b"[]"),
            Err(ParseError::NotAnObject)
        ));
        assert!(matches!(Manifest::parse(b"{"), Err(ParseError::Json(_))));
        // §3: UTF-8, no BOM.
        assert!(matches!(
            Manifest::parse("\u{feff}{}".as_bytes()),
            Err(ParseError::Json(_))
        ));
    }

    #[test]
    fn encryption_distinguishes_null_from_absent() {
        let plaintext = match Manifest::parse(br#"{"encryption": null}"#) {
            Ok(manifest) => manifest,
            Err(err) => panic!("{err}"),
        };
        assert!(matches!(plaintext.encryption(), EncryptionField::Null));
        assert!(plaintext.has(field::ENCRYPTION));
        assert!(!plaintext.is_encrypted());

        let absent = match Manifest::parse(b"{}") {
            Ok(manifest) => manifest,
            Err(err) => panic!("{err}"),
        };
        assert!(matches!(absent.encryption(), EncryptionField::Absent));
        assert!(!absent.has(field::ENCRYPTION));
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let file = "# a comment\n\n   \n  # indented comment\n";
        assert!(parse_recipients(file).is_empty());
    }

    #[test]
    fn classifies_an_x25519_recipient() {
        let key = format!("age1{}", "q".repeat(X25519_LENGTH - 4));
        assert_eq!(key.len(), X25519_LENGTH);
        assert_eq!(classify_recipient(&key), Some(RecipientKind::X25519));
    }

    #[test]
    fn rejects_an_age_recipient_of_the_wrong_shape() {
        // Right prefix, too short.
        assert_eq!(
            classify_recipient("age1qqqq"),
            Some(RecipientKind::Malformed)
        );
        // Right length, but `b` is not in the bech32 alphabet.
        let bad = format!("age1{}", "b".repeat(X25519_LENGTH - 4));
        assert_eq!(classify_recipient(&bad), Some(RecipientKind::Malformed));
    }

    #[test]
    fn classifies_ssh_and_passphrase_recipients() {
        assert_eq!(
            classify_recipient("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA user@host"),
            Some(RecipientKind::Ssh)
        );
        assert_eq!(
            classify_recipient("ssh-rsa AAAAB3NzaC1yc2EAAAA"),
            Some(RecipientKind::Ssh)
        );
        assert_eq!(
            classify_recipient("passphrase"),
            Some(RecipientKind::Passphrase)
        );
        assert_eq!(
            classify_recipient("PASSPHRASE"),
            Some(RecipientKind::Passphrase)
        );
        assert_eq!(
            classify_recipient("scrypt abc 18"),
            Some(RecipientKind::Passphrase)
        );
    }

    #[test]
    fn line_numbers_are_one_based_and_skip_comments() {
        let file = "# comment\nage1bad\n\nssh-rsa AAAA\n";
        let lines = parse_recipients(file);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].number, 2);
        assert_eq!(lines[0].kind, RecipientKind::Malformed);
        assert_eq!(lines[1].number, 4);
        assert_eq!(lines[1].kind, RecipientKind::Ssh);
    }
}

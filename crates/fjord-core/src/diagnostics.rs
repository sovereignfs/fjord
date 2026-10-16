//! Diagnostic codes.
//!
//! This module is the **single source of truth** for every code the toolchain
//! can emit. The table in `README.md` is generated from it, and the fixtures
//! under `tests/fixtures/broken/<code>/` are named after it.
//!
//! Codes are published API. Once a code has shipped, its meaning must never
//! change: add new codes, never renumber or repurpose existing ones. A code
//! that is withdrawn stays reserved and is never reused.
//!
//! Each variant cites the section of `SPEC.md` it enforces, so that a change
//! to the specification can be traced to the checks it affects.
//!
//! # Reserved numbers
//!
//! `E107`, `E205` and `W603` are **reserved and MUST NOT be assigned**. They
//! were drafted alongside the codes below and withdrawn before release;
//! their numbers are burnt so that a repository or a CI configuration
//! written against a draft cannot be silently misread by a later build. Add
//! new codes at the end of their range.

use std::fmt;

/// Whether a diagnostic blocks conformance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// The repository does not conform. `fjord verify` exits 1.
    Error,
    /// Conforming, but something deserves attention.
    Warning,
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Severity::Error => write!(f, "error"),
            Severity::Warning => write!(f, "warning"),
        }
    }
}

/// Every diagnostic the toolchain can emit.
///
/// Ranges: `E1xx` repository, `E2xx` vault, `E3xx` encryption,
/// `E4xx` documents, `E5xx` paths, `W6xx` warnings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[non_exhaustive]
pub enum Code {
    // --- E1xx repository -------------------------------------------------
    /// `fjord.json` is absent from the repository root. Spec §3.
    ManifestMissing,
    /// `fjord.json` is not valid JSON. Spec §3.
    ManifestUnparseable,
    /// `fjord` version exceeds what this build implements. Spec §10.1.
    ///
    /// Reading is permitted; writing must be refused.
    UnsupportedVersion,
    /// A required manifest field is absent. Spec §3, §4.
    RequiredFieldMissing,
    /// A field that must be a ULID is not one. Spec §8.3.
    InvalidUlid,
    /// A vault listed in `fjord.json` is not present on disk. Spec §2.1.
    VaultNotOnDisk,
    /// A vault's `id` disagrees between the two manifests. Spec §3.
    VaultIdMismatch,
    /// `.gitattributes` is missing or lacks the `*.age -merge` guard. Spec §9.
    MergeGuardMissing,
    /// A field is present but its value is not valid for its type or
    /// domain. Spec §3, §4, §4.1, §7.
    ///
    /// The general case, for fields with no dedicated code: `vaults` that is
    /// not an array, `fileNaming` that is neither `"plain"` nor `"id"`,
    /// `encryption.armor` that is not a boolean. Distinct from
    /// [`Code::RequiredFieldMissing`], which is about absence — reporting a
    /// malformed value as a missing field would send a user looking for the
    /// wrong thing.
    InvalidFieldValue,

    // --- E2xx vault ------------------------------------------------------
    /// An unencrypted file is present inside an encrypted vault. Spec §6.5.
    ///
    /// The most serious diagnostic in the set: it means plaintext has been
    /// committed to a vault the user believes is protected.
    PlaintextInEncryptedVault,
    /// `fjord.vault.json` is not valid JSON. Spec §4.
    VaultManifestUnparseable,
    /// `encryption.tool` names something other than `age`. Spec §4.1.
    UnsupportedEncryptionTool,
    /// The recipients file named by the manifest is absent. Spec §6.2.
    RecipientsFileMissing,
    /// A passphrase recipient appears in the recipients file. Spec §6.2.
    PassphraseRecipient,
    /// A vault is nested inside another vault. Spec §2.3.
    NestedVault,
    /// An encrypted vault lacks its plaintext-guard `.gitignore`. Spec §6.5.
    PlaintextGuardMissing,
    /// A line in the recipients file is neither a comment nor a recipient.
    /// Spec §6.2.
    MalformedRecipient,

    // --- E3xx encryption -------------------------------------------------
    /// An age payload could not be parsed or authenticated. Spec §6.1.
    ///
    /// `fjord verify` checks the **header** only, which needs no identity:
    /// a file named `.age` that is not an age file at all — truncated,
    /// replaced by a merge conflict, corrupted in transfer. Authenticating
    /// the body requires a key, so that happens when the file is read.
    CorruptPayload,
    /// An `.age` file is present in a plaintext vault. Spec §6.
    EncryptedFileInPlaintextVault,
    /// A tar container does not hold exactly one regular file, or its entry
    /// name contains a path component. Spec §6.4.
    MalformedContainer,
    /// `fileNaming` is `"id"` but the file name is not a valid ULID.
    /// Spec §7.2.
    FileNameNotUlid,
    /// `container` is `"none"` while `fileNaming` is `"id"`. Spec §7.2.
    ContainerRequiredForIdNaming,
    /// `fileNaming` is `"id"` on a vault that is not encrypted. Spec §7.2.
    IdNamingOnPlaintextVault,

    // --- E4xx documents --------------------------------------------------
    /// Two documents claim the same `id`. Spec §8.2.
    DuplicateId,
    /// A frontmatter block is present but is not a YAML mapping. Spec §8.1.
    FrontmatterUnparseable,
    /// `id` is present but is not a valid ULID. Spec §8.3.
    DocumentIdInvalid,
    /// Frontmatter does not begin at byte 0, or a byte-order mark precedes
    /// it. Spec §8.1.
    FrontmatterNotAtStart,
    /// A timestamp is not RFC 3339 in UTC. Spec §3, §4, §8.1.
    ///
    /// Covers `createdAt` in both manifests as well as a document's
    /// `created`: §3, §4 and §8.1 impose one rule, so one code enforces it.
    /// The diagnostic's detail names the field.
    InvalidTimestamp,

    // --- E5xx paths ------------------------------------------------------
    /// A name contains a character forbidden by the path rules. Spec §5.
    ForbiddenCharacter,
    /// A name ends with a dot or a space, which Windows cannot store.
    /// Spec §5.
    TrailingDotOrSpace,
    /// A name collides with a Windows reserved device name. Spec §5.
    ReservedDeviceName,
    /// A path component exceeds 255 bytes. Spec §5.
    ComponentTooLong,
    /// Two entries in one directory differ only by case, which collapses on
    /// case-insensitive filesystems. Spec §5.
    CaseCollision,
    /// A name is not in Unicode NFC. Spec §5.
    NotNfcNormalised,
    /// A manifest path is absolute or contains `..`. Spec §5.
    PathTraversal,
    /// A symbolic link resolves outside the repository. Spec §5.
    SymlinkEscapesRepository,

    // --- W6xx warnings ---------------------------------------------------
    /// A vault exists on disk but is absent from `fjord.json`. Spec §2.1.
    ///
    /// Not an error: the filesystem is authoritative. The manifest should be
    /// repaired.
    VaultNotInManifest,
    /// An encrypted vault has no recipients. Valid, but nothing can be
    /// written to it. Spec §6.2.
    NoRecipients,
    /// A file exceeds the recommended size. Spec §1.1.
    FileTooLarge,
    /// A path exceeds 240 bytes and may fail to check out on Windows.
    /// Spec §5.
    PathTooLong,
}

impl Code {
    /// The stable wire identifier, e.g. `"E201"`.
    pub fn as_str(self) -> &'static str {
        use Code::*;
        match self {
            ManifestMissing => "E101",
            ManifestUnparseable => "E102",
            UnsupportedVersion => "E103",
            RequiredFieldMissing => "E104",
            InvalidUlid => "E105",
            VaultNotOnDisk => "E106",
            VaultIdMismatch => "E108",
            MergeGuardMissing => "E109",
            InvalidFieldValue => "E110",

            PlaintextInEncryptedVault => "E201",
            VaultManifestUnparseable => "E202",
            UnsupportedEncryptionTool => "E203",
            RecipientsFileMissing => "E204",
            PassphraseRecipient => "E206",
            NestedVault => "E207",
            PlaintextGuardMissing => "E208",
            MalformedRecipient => "E209",

            CorruptPayload => "E301",
            EncryptedFileInPlaintextVault => "E302",
            MalformedContainer => "E303",
            FileNameNotUlid => "E304",
            ContainerRequiredForIdNaming => "E305",
            IdNamingOnPlaintextVault => "E306",

            DuplicateId => "E401",
            FrontmatterUnparseable => "E402",
            DocumentIdInvalid => "E403",
            FrontmatterNotAtStart => "E404",
            InvalidTimestamp => "E405",

            ForbiddenCharacter => "E501",
            TrailingDotOrSpace => "E502",
            ReservedDeviceName => "E503",
            ComponentTooLong => "E504",
            CaseCollision => "E505",
            NotNfcNormalised => "E506",
            PathTraversal => "E507",
            SymlinkEscapesRepository => "E508",

            VaultNotInManifest => "W601",
            NoRecipients => "W602",
            FileTooLarge => "W604",
            PathTooLong => "W605",
        }
    }

    /// One line, lower case, no trailing period — rendered after the code.
    pub fn message(self) -> &'static str {
        use Code::*;
        match self {
            ManifestMissing => "fjord.json missing",
            ManifestUnparseable => "fjord.json is not valid JSON",
            UnsupportedVersion => "format version is newer than this tool supports",
            RequiredFieldMissing => "required field missing",
            InvalidUlid => "field is not a valid ULID",
            VaultNotOnDisk => "vault listed in the manifest does not exist on disk",
            VaultIdMismatch => "vault id disagrees with its fjord.vault.json",
            MergeGuardMissing => ".gitattributes missing or lacks the *.age -merge guard",
            InvalidFieldValue => "field value is not valid for its type or domain",

            PlaintextInEncryptedVault => "plaintext file in an encrypted vault",
            VaultManifestUnparseable => "fjord.vault.json is not valid JSON",
            UnsupportedEncryptionTool => "encryption.tool is not supported",
            RecipientsFileMissing => "recipients file is missing",
            PassphraseRecipient => "passphrase recipient is not permitted",
            NestedVault => "nested vaults are not permitted in version 1",
            PlaintextGuardMissing => "encrypted vault is missing its plaintext-guard .gitignore",
            MalformedRecipient => "malformed line in the recipients file",

            CorruptPayload => "age payload is corrupt or unreadable",
            EncryptedFileInPlaintextVault => ".age file in a plaintext vault",
            MalformedContainer => "tar container is malformed",
            FileNameNotUlid => "fileNaming is \"id\" but the file name is not a ULID",
            ContainerRequiredForIdNaming => "container is \"none\" but fileNaming is \"id\"",
            IdNamingOnPlaintextVault => "fileNaming is \"id\" on a plaintext vault",

            DuplicateId => "duplicate id",
            FrontmatterUnparseable => "frontmatter is not a YAML mapping",
            DocumentIdInvalid => "id is not a valid ULID",
            FrontmatterNotAtStart => "frontmatter does not begin at byte 0",
            InvalidTimestamp => "timestamp is not RFC 3339 in UTC",

            ForbiddenCharacter => "forbidden character in name",
            TrailingDotOrSpace => "name ends with a dot or a space",
            ReservedDeviceName => "name is a Windows reserved device name",
            ComponentTooLong => "path component exceeds 255 bytes",
            CaseCollision => "two entries differ only by case",
            NotNfcNormalised => "name is not Unicode NFC",
            PathTraversal => "path is absolute or contains a .. segment",
            SymlinkEscapesRepository => "symlink resolves outside the repository",

            VaultNotInManifest => "vault on disk is not listed in fjord.json",
            NoRecipients => "encrypted vault has no recipients, so nothing can be written to it",
            FileTooLarge => "file exceeds 25 MB; Fjord is for documents, not media",
            PathTooLong => "path exceeds 240 bytes and may fail to check out on Windows",
        }
    }

    pub fn severity(self) -> Severity {
        match self {
            Code::VaultNotInManifest
            | Code::NoRecipients
            | Code::FileTooLarge
            | Code::PathTooLong => Severity::Warning,
            _ => Severity::Error,
        }
    }

    /// Whether `fjord verify --fix` may repair this without human review.
    ///
    /// Deliberately conservative: anything that could lose data, move a
    /// document, or touch content is excluded. See README
    /// § What `--fix` will and will not do.
    pub fn is_auto_fixable(self) -> bool {
        matches!(
            self,
            Code::MergeGuardMissing
                | Code::PlaintextGuardMissing
                | Code::NotNfcNormalised
                | Code::VaultNotInManifest
        )
    }

    /// Every code, for exhaustiveness tests and README generation.
    pub fn all() -> &'static [Code] {
        use Code::*;
        &[
            ManifestMissing,
            ManifestUnparseable,
            UnsupportedVersion,
            RequiredFieldMissing,
            InvalidUlid,
            VaultNotOnDisk,
            VaultIdMismatch,
            MergeGuardMissing,
            InvalidFieldValue,
            PlaintextInEncryptedVault,
            VaultManifestUnparseable,
            UnsupportedEncryptionTool,
            RecipientsFileMissing,
            PassphraseRecipient,
            NestedVault,
            PlaintextGuardMissing,
            MalformedRecipient,
            CorruptPayload,
            EncryptedFileInPlaintextVault,
            MalformedContainer,
            FileNameNotUlid,
            ContainerRequiredForIdNaming,
            IdNamingOnPlaintextVault,
            DuplicateId,
            FrontmatterUnparseable,
            DocumentIdInvalid,
            FrontmatterNotAtStart,
            InvalidTimestamp,
            ForbiddenCharacter,
            TrailingDotOrSpace,
            ReservedDeviceName,
            ComponentTooLong,
            CaseCollision,
            NotNfcNormalised,
            PathTraversal,
            SymlinkEscapesRepository,
            VaultNotInManifest,
            NoRecipients,
            FileTooLarge,
            PathTooLong,
        ]
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// One finding, located.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub code: Code,
    /// Repository-relative path, or `None` for repository-wide findings.
    pub path: Option<String>,
    /// Extra context appended to the standard message, if any.
    pub detail: Option<String>,
}

impl Diagnostic {
    pub fn new(code: Code) -> Self {
        Self {
            code,
            path: None,
            detail: None,
        }
    }

    pub fn at(code: Code, path: impl Into<String>) -> Self {
        Self {
            code,
            path: Some(path.into()),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn severity(&self) -> Severity {
        self.code.severity()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Codes are published API; two variants sharing one identifier would
    /// make a code ambiguous forever.
    #[test]
    fn codes_are_unique() {
        let mut seen = HashSet::new();
        for code in Code::all() {
            assert!(
                seen.insert(code.as_str()),
                "duplicate code {}",
                code.as_str()
            );
        }
    }

    /// `all()` is maintained by hand; this catches a variant added without
    /// being registered.
    #[test]
    fn all_is_complete() {
        // Update this count deliberately when adding a code, so that adding
        // one without adding a fixture is a visible decision.
        assert_eq!(Code::all().len(), 40);
    }

    /// The module doc burns three numbers. A code that reuses one would make
    /// a draft repository's diagnostics mean something new.
    #[test]
    fn reserved_numbers_are_not_assigned() {
        for code in Code::all() {
            let identifier = code.as_str();
            assert!(
                !matches!(identifier, "E107" | "E205" | "W603"),
                "{identifier} is reserved and must not be assigned"
            );
        }
    }

    #[test]
    fn warnings_are_the_w6xx_range() {
        for code in Code::all() {
            let is_w = code.as_str().starts_with('W');
            assert_eq!(
                is_w,
                code.severity() == Severity::Warning,
                "{} severity disagrees with its range",
                code
            );
        }
    }

    #[test]
    fn messages_are_single_line_and_unpunctuated() {
        for code in Code::all() {
            let m = code.message();
            assert!(!m.is_empty(), "{} has no message", code);
            assert!(!m.contains('\n'), "{} message spans lines", code);
            assert!(!m.ends_with('.'), "{} message ends with a period", code);
        }
    }
}

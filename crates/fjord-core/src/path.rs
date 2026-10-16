//! Name and path rules. Spec §5.
//!
//! These rules exist so a repository created on one operating system can be
//! checked out on another without loss. They are pure predicates over
//! strings — no filesystem access, so they are equally usable when
//! validating a name a user has just typed, a path read from a manifest, or
//! an entry found on disk.

use crate::diagnostics::Code;
use indexmap::IndexMap;
use unicode_normalization::{is_nfc, UnicodeNormalization};

/// Characters no name may contain. Spec §5 rule 2.
pub const FORBIDDEN_CHARACTERS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Maximum bytes in one path component. Spec §5 rule 5.
pub const MAX_COMPONENT_BYTES: usize = 255;

/// Windows device names, which cannot be used as file names on Windows even
/// with an extension. Spec §5 rule 4.
pub const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Whether `component` is a Windows device name, with or without an
/// extension, case-insensitively. Spec §5 rule 4.
///
/// Trailing whitespace is trimmed before the comparison because Windows
/// does the same: `"CON "` resolves to the console device, not to a file
/// called `CON `. Rule 3 rejects the trailing space as well, but a name
/// that quietly *becomes* a device is worth naming for what it is.
pub fn is_reserved_device_name(component: &str) -> bool {
    let stem = match component.split('.').next() {
        Some(stem) => stem,
        None => component,
    }
    .trim_end();
    RESERVED_DEVICE_NAMES
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem))
}

/// Every rule `component` breaks, in diagnostic order.
///
/// One name can break several rules at once, so this returns all of them
/// rather than the first: a user renaming `CON .` should be told about both
/// problems in one pass.
pub fn check_component(component: &str) -> Vec<Code> {
    let mut codes = Vec::new();

    let has_forbidden = component
        .chars()
        .any(|c| FORBIDDEN_CHARACTERS.contains(&c) || (c as u32) <= 0x1f);
    if has_forbidden {
        codes.push(Code::ForbiddenCharacter);
    }

    if component.ends_with('.') || component.ends_with(' ') {
        codes.push(Code::TrailingDotOrSpace);
    }

    if is_reserved_device_name(component) {
        codes.push(Code::ReservedDeviceName);
    }

    if component.len() > MAX_COMPONENT_BYTES {
        codes.push(Code::ComponentTooLong);
    }

    if !is_nfc(component) {
        codes.push(Code::NotNfcNormalised);
    }

    codes
}

/// `name` in Unicode NFC. Spec §5 rule 1.
///
/// macOS hands out NFD from some APIs. Writing that straight to disk makes
/// Git show one name twice, so every name is normalised before it is
/// written.
pub fn to_nfc(name: &str) -> String {
    name.nfc().collect()
}

/// Whether a path read from a manifest may be followed. Spec §5.
///
/// An empty path is rejected along with the traversal forms: it resolves to
/// the directory doing the resolving, which is never what a manifest meant
/// and is the one case where a nonsensical path silently succeeds.
pub fn check_manifest_path(path: &str) -> Option<Code> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.split('/').any(|component| component == "..")
    {
        return Some(Code::PathTraversal);
    }
    None
}

/// Groups of names in one directory that differ only by case. Spec §5
/// rule 6.
///
/// Returned in the order the first member of each group was seen, so output
/// is stable across runs.
pub fn case_collisions(names: &[String]) -> Vec<Vec<String>> {
    let mut groups: IndexMap<String, Vec<String>> = IndexMap::new();
    for name in names {
        groups
            .entry(name.to_lowercase())
            .or_default()
            .push(name.clone());
    }
    groups
        .into_iter()
        .filter(|(_, group)| group.len() > 1)
        .map(|(_, group)| group)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_name_breaks_nothing() {
        assert!(check_component("sync-design.md").is_empty());
        assert!(check_component("Projects").is_empty());
        // NFC multibyte names are fine; it is NFD that is not.
        assert!(check_component("café.md").is_empty());
    }

    #[test]
    fn forbidden_characters_are_caught() {
        for bad in [
            "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b",
        ] {
            assert_eq!(
                check_component(bad),
                vec![Code::ForbiddenCharacter],
                "{bad} was accepted"
            );
        }
        assert_eq!(
            check_component("a\u{0}b"),
            vec![Code::ForbiddenCharacter],
            "a NUL byte was accepted"
        );
        assert_eq!(
            check_component("a\u{1f}b"),
            vec![Code::ForbiddenCharacter],
            "a control character was accepted"
        );
    }

    #[test]
    fn trailing_dot_or_space_is_caught() {
        assert_eq!(check_component("notes."), vec![Code::TrailingDotOrSpace]);
        assert_eq!(check_component("notes "), vec![Code::TrailingDotOrSpace]);
        // A leading dot is a dotfile, not an error.
        assert!(check_component(".gitignore").is_empty());
    }

    #[test]
    fn device_names_are_caught_with_and_without_an_extension() {
        assert!(is_reserved_device_name("CON"));
        assert!(is_reserved_device_name("con"));
        assert!(is_reserved_device_name("Con.txt"));
        assert!(is_reserved_device_name("COM9.md"));
        assert!(is_reserved_device_name("LPT1"));

        // Windows trims trailing whitespace before resolving the name, so
        // these are the device too.
        assert!(is_reserved_device_name("CON "));
        assert!(is_reserved_device_name("CON ."));

        assert!(!is_reserved_device_name("CONTACT"));
        assert!(!is_reserved_device_name(" CON"));
        assert!(!is_reserved_device_name("COM0"));
        assert!(!is_reserved_device_name("COM10"));
        assert!(!is_reserved_device_name(""));
    }

    #[test]
    fn length_is_measured_in_bytes() {
        let ascii = "a".repeat(MAX_COMPONENT_BYTES);
        assert!(check_component(&ascii).is_empty());
        let too_long = "a".repeat(MAX_COMPONENT_BYTES + 1);
        assert_eq!(check_component(&too_long), vec![Code::ComponentTooLong]);

        // 128 two-byte characters is 256 bytes: over the limit despite being
        // well under 255 characters.
        let multibyte = "é".repeat(128);
        assert_eq!(multibyte.len(), 256);
        assert_eq!(check_component(&multibyte), vec![Code::ComponentTooLong]);
    }

    #[test]
    fn decomposed_names_are_caught() {
        // "e" followed by a combining acute accent: NFD, not NFC.
        let nfd = "cafe\u{0301}.md";
        assert_eq!(check_component(nfd), vec![Code::NotNfcNormalised]);
        assert_eq!(to_nfc(nfd), "café.md");
        assert!(check_component(&to_nfc(nfd)).is_empty());
    }

    #[test]
    fn one_name_can_break_several_rules() {
        let codes = check_component("CON ");
        assert!(codes.contains(&Code::TrailingDotOrSpace));
        assert!(codes.contains(&Code::ReservedDeviceName));
    }

    #[test]
    fn manifest_paths_reject_traversal() {
        assert_eq!(check_manifest_path("Public"), None);
        assert_eq!(check_manifest_path("a/b"), None);

        assert_eq!(check_manifest_path(""), Some(Code::PathTraversal));
        assert_eq!(check_manifest_path("/Public"), Some(Code::PathTraversal));
        assert_eq!(check_manifest_path("../Public"), Some(Code::PathTraversal));
        assert_eq!(check_manifest_path("a/../b"), Some(Code::PathTraversal));
        assert_eq!(check_manifest_path("a\\b"), Some(Code::PathTraversal));

        // A name merely containing dots is not traversal.
        assert_eq!(check_manifest_path("..notes"), None);
        assert_eq!(check_manifest_path("a/..b/c"), None);
    }

    #[test]
    fn case_collisions_are_grouped() {
        let names = vec![
            "Notes.md".to_string(),
            "notes.md".to_string(),
            "other.md".to_string(),
            "NOTES.MD".to_string(),
        ];
        let groups = case_collisions(&names);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].len(), 3);
        assert!(groups[0].contains(&"Notes.md".to_string()));
        assert!(groups[0].contains(&"NOTES.MD".to_string()));
    }

    #[test]
    fn distinct_names_do_not_collide() {
        let names = vec!["a.md".to_string(), "b.md".to_string()];
        assert!(case_collisions(&names).is_empty());
    }
}

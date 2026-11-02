// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Comparing tags. Spec §8.1.
//!
//! Two tags are the same when they are equal after NFC normalisation and Unicode's default lowercase
//! mapping, and `/` nests them: `project/fjord` is under `project`. Comparison never rewrites a file; a
//! tag is kept as it was written.
//!
//! The lowercase mapping, and not Unicode case folding, because it is what every client's standard
//! library has (`str::to_lowercase` here, `String.prototype.toLowerCase` in JavaScript), so that every
//! client finds the same tags the same.

use crate::path::to_nfc;

/// The form a tag is compared in. Not for writing back: a file keeps the tag as it was written.
pub fn fold(tag: &str) -> String {
    // NFC again after lowercasing: a lowercase mapping can produce a sequence NFC would compose.
    to_nfc(&to_nfc(tag).to_lowercase())
}

/// Whether two tags are the same tag.
pub fn same(a: &str, b: &str) -> bool {
    fold(a) == fold(b)
}

/// Whether `tag` is `parent` or nested under it: `project/fjord` is under `project`, and so is
/// `project`. A trailing `/` on `parent` is ignored.
pub fn is_under(tag: &str, parent: &str) -> bool {
    let tag = fold(tag);
    let parent = fold(parent);
    let parent = parent.trim_end_matches('/');
    if parent.is_empty() {
        return false;
    }
    tag == parent
        || tag
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_does_not_make_a_different_tag() {
        assert!(same("Work", "work"));
        assert!(same("WORK", "wOrK"));
        assert!(same("Ελλάδα", "ΕΛΛΆΔΑ"));
        assert!(!same("work", "working"));
    }

    #[test]
    fn composed_and_decomposed_are_one_tag() {
        assert!(same("caf\u{e9}", "cafe\u{301}"));
        assert!(same("CAF\u{c9}", "cafe\u{301}"));
    }

    #[test]
    fn a_slash_nests() {
        assert!(is_under("project/fjord", "project"));
        assert!(is_under("Project/Fjord", "project/"));
        assert!(is_under("project", "project"));
        assert!(is_under("a/b/c", "a/b"));
        assert!(!is_under("projects", "project"));
        assert!(!is_under("project", "project/fjord"));
        assert!(!is_under("project", ""));
    }
}

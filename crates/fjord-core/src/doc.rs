// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fjord Docs and frontmatter. Spec §8.
//!
//! A **Fjord Doc** is a `.md` file whose frontmatter carries a valid `id`.
//! Every other file is a **vault file** — stored and synced identically,
//! carrying no Fjord metadata and expected to carry none. Absent
//! frontmatter is therefore *valid*, not a malformed Doc (§8.2), and this
//! module never treats a plain Markdown file as broken.
//!
//! Frontmatter is held as an ordered map of unparsed YAML values, for the
//! reasons given in [`crate::manifest`]: a non-ULID `id` must be reportable
//! as [`Code::DocumentIdInvalid`][c] rather than collapsing the whole file
//! into a parse error, and unknown keys must survive a round trip
//! untouched (§8.2, invariant 3).
//!
//! Comments are not preserved. §8.2 permits this — keys MUST survive,
//! comments SHOULD — and preserving them needs an AST-level parser.
//!
//! [c]: crate::diagnostics::Code::DocumentIdInvalid

use crate::scalar;
use indexmap::IndexMap;
use serde_yaml_ng::Value;

/// The fence that opens and closes a frontmatter block. Spec §8.1.
pub const FENCE: &str = "---";

/// Keys the specification fixes. Spec §8.1.
pub mod key {
    pub const ID: &str = "id";
    pub const TITLE: &str = "title";
    pub const CREATED: &str = "created";
    pub const TAGS: &str = "tags";
    pub const ALIASES: &str = "aliases";
    /// Reserved for client state. Clients MUST NOT put their own keys
    /// outside it. Spec §8.1.
    pub const FJORD: &str = "fjord";
}

/// The result of looking for frontmatter at the head of a file.
#[derive(Debug, Clone)]
pub enum Parse {
    /// No frontmatter. A vault file, which is valid. Spec §8.2.
    Absent,
    /// A block appears, but not at byte 0 — preceded by a byte-order mark
    /// or a blank line. Spec §8.1.
    NotAtStart,
    /// Opened with a fence that is never closed.
    Unterminated,
    /// Well-formed YAML, but a sequence or a scalar rather than a mapping.
    NotAMapping,
    /// Malformed YAML. Carries the parser's message.
    Unparseable(String),
    /// A mapping.
    Present {
        frontmatter: Frontmatter,
        /// Byte offset of the document body, just past the closing fence.
        body_offset: usize,
    },
}

/// A parsed frontmatter mapping, in document order.
#[derive(Debug, Clone, Default)]
pub struct Frontmatter {
    raw: IndexMap<String, Value>,
}

impl Frontmatter {
    /// An empty mapping, as written by `---\n---\n`.
    pub fn empty() -> Self {
        Self::default()
    }

    /// The mapping as parsed, in document order. Preserving this is what
    /// makes "edit it in any tool" survive more than one round trip.
    pub fn raw(&self) -> &IndexMap<String, Value> {
        &self.raw
    }

    /// A key's value, whatever its type.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.raw.get(key)
    }

    /// Whether a key is present, whatever its type.
    pub fn has(&self, key: &str) -> bool {
        self.raw.contains_key(key)
    }

    /// A key's value as a string, or `None` if absent or another type.
    pub fn string(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(Value::as_str)
    }

    /// `id` as written, without judging it. A present-but-wrong `id` is a
    /// diagnostic, so the caller needs to see it.
    pub fn id(&self) -> Option<&str> {
        self.string(key::ID)
    }

    /// `id` only if it is a valid ULID — which is what makes this file a
    /// Doc rather than a vault file. Spec §8, §8.3.
    pub fn doc_id(&self) -> Option<&str> {
        self.id().filter(|id| scalar::is_ulid(id))
    }

    /// `created`, as written. Spec §8.1.
    pub fn created(&self) -> Option<&str> {
        self.string(key::CREATED)
    }

    /// `title`, which is advisory. Spec §8.2.
    pub fn title(&self) -> Option<&str> {
        self.string(key::TITLE)
    }

    /// Serialise back to YAML, preserving key order.
    ///
    /// Used by every command that rewrites a file, and by the round-trip
    /// test that guards invariant 3.
    pub fn to_yaml(&self) -> Result<String, serde_yaml_ng::Error> {
        serde_yaml_ng::to_string(&self.raw)
    }
}

/// Build a new Doc: frontmatter plus a level-one heading. Spec §8.1.
///
/// The mapping is serialised by the YAML writer rather than formatted by
/// hand, so a title containing a colon, a quote or a leading `-` cannot
/// produce a file this crate would then refuse to parse.
pub fn new_document(id: &str, title: &str, created: &str) -> Result<String, serde_yaml_ng::Error> {
    let mut frontmatter: IndexMap<String, Value> = IndexMap::new();
    frontmatter.insert(key::ID.to_string(), Value::String(id.to_string()));
    frontmatter.insert(key::TITLE.to_string(), Value::String(title.to_string()));
    frontmatter.insert(key::CREATED.to_string(), Value::String(created.to_string()));

    let yaml = serde_yaml_ng::to_string(&frontmatter)?;
    Ok(format!("{FENCE}\n{yaml}{FENCE}\n\n# {title}\n"))
}

/// Replace a document's `id`, preserving every other key and its order.
/// Spec §8.2, §9.1.
///
/// §9.1's remedy for an unmergeable conflict is to keep one side in place
/// and write the other alongside it "as a new Doc with a fresh `id`". The
/// fresh id is not cosmetic: two files sharing one id is
/// [`Code::DuplicateId`][c], so copying a document without reassigning it
/// would resolve a conflict by creating a conformance error.
///
/// Returns `None` for a file with no frontmatter to rewrite.
///
/// [c]: crate::diagnostics::Code::DuplicateId
pub fn with_fresh_id(text: &str, id: &str) -> Option<String> {
    let (frontmatter, body_offset) = match parse(text) {
        Parse::Present {
            frontmatter,
            body_offset,
        } => (frontmatter, body_offset),
        _ => return None,
    };

    // `IndexMap::insert` on an existing key keeps its position, so the
    // document's key order survives (§8.2) along with every unknown key.
    let mut raw = frontmatter.raw().clone();
    raw.insert(key::ID.to_string(), Value::String(id.to_string()));

    let yaml = serde_yaml_ng::to_string(&raw).ok()?;
    Some(format!("{FENCE}\n{yaml}{FENCE}\n{}", &text[body_offset..]))
}

/// Give a file the frontmatter of a Doc, keeping whatever it already has.
/// Spec §8.1, §8.2.
///
/// §8.2 says a client "MAY assign an `id` and promote it to a Doc when the
/// user edits it, and MUST NOT rewrite files merely because it scanned
/// them". Importing is the former: an explicit instruction to bring files
/// in, not a scan.
///
/// Existing keys are preserved, including unknown ones and their order
/// (invariant 3), and `title` and `created` are only filled in when absent
/// — a file arriving from another tool may well have its own, and they are
/// better than anything this function could invent.
pub fn promote(text: &str, id: &str, created: &str, title: &str) -> Option<String> {
    let (mut raw, body) = match parse(text) {
        Parse::Present {
            frontmatter,
            body_offset,
        } => (frontmatter.raw().clone(), text[body_offset..].to_string()),
        // No frontmatter to keep: the whole file is the body.
        Parse::Absent => (IndexMap::new(), format!("\n{text}")),
        // A block that is there but broken is not ours to rewrite: doing so
        // would discard whatever the author meant by it.
        _ => return None,
    };

    // `insert` on an existing key keeps its position, so a file that
    // already had an `id` in the middle of its frontmatter keeps the shape
    // it had.
    raw.insert(key::ID.to_string(), Value::String(id.to_string()));
    raw.entry(key::TITLE.to_string())
        .or_insert_with(|| Value::String(title.to_string()));
    raw.entry(key::CREATED.to_string())
        .or_insert_with(|| Value::String(created.to_string()));

    let yaml = serde_yaml_ng::to_string(&raw).ok()?;
    Some(format!("{FENCE}\n{yaml}{FENCE}\n{body}"))
}

/// The title a document implies: its first level-one heading, else the file
/// name without its extension. Spec §8.2.
pub fn implied_title(text: &str, file_name: &str) -> String {
    for line in text.lines() {
        if let Some(heading) = line.strip_prefix("# ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                return heading.to_string();
            }
        }
    }
    file_name
        .strip_suffix(".md")
        .unwrap_or(file_name)
        .to_string()
}

/// Advance one line, returning the line without its terminator and the
/// offset of the next one.
///
/// A trailing `\r` is stripped so a CRLF file behaves identically to an LF
/// one — Git normalises on checkout, but a file can arrive either way.
fn next_line(text: &str, cursor: usize) -> Option<(&str, usize)> {
    if cursor >= text.len() {
        return None;
    }
    let rest = &text[cursor..];
    match rest.find('\n') {
        Some(index) => Some((rest[..index].trim_end_matches('\r'), cursor + index + 1)),
        None => Some((rest.trim_end_matches('\r'), text.len())),
    }
}

/// Whether a frontmatter block appears after something that should not
/// precede it — a byte-order mark, or a blank line. Spec §8.1.
fn fence_appears_late(text: &str) -> bool {
    let without_bom = text.trim_start_matches('\u{feff}');
    let mut cursor = 0;
    while let Some((line, next)) = next_line(without_bom, cursor) {
        if line.trim().is_empty() {
            cursor = next;
            continue;
        }
        return line == FENCE;
    }
    false
}

/// Look for frontmatter at the head of `text`. Spec §8.1.
///
/// The YAML is parsed with `serde_yaml_ng`, which constructs no arbitrary
/// objects and honours no custom tags — §8.1 requires a safe loader,
/// because frontmatter is untrusted input.
pub fn parse(text: &str) -> Parse {
    let (first, after_first) = match next_line(text, 0) {
        Some(line) => line,
        None => return Parse::Absent,
    };

    if first != FENCE {
        if fence_appears_late(text) {
            return Parse::NotAtStart;
        }
        return Parse::Absent;
    }

    let yaml_start = after_first;
    let mut cursor = after_first;
    loop {
        let (line, next) = match next_line(text, cursor) {
            Some(line) => line,
            None => return Parse::Unterminated,
        };
        if line == FENCE {
            return parse_mapping(&text[yaml_start..cursor], next);
        }
        cursor = next;
    }
}

fn parse_mapping(yaml: &str, body_offset: usize) -> Parse {
    // `---\n---\n` is an empty mapping, not a broken one: it has no `id`, so
    // the file is simply a vault file.
    if yaml.trim().is_empty() {
        return Parse::Present {
            frontmatter: Frontmatter::empty(),
            body_offset,
        };
    }

    match serde_yaml_ng::from_str::<IndexMap<String, Value>>(yaml) {
        Ok(raw) => Parse::Present {
            frontmatter: Frontmatter { raw },
            body_offset,
        },
        Err(err) => match serde_yaml_ng::from_str::<Value>(yaml) {
            // Valid YAML, but not a mapping of string keys. A mapping whose
            // keys are not strings lands here too, and is reported as
            // unparseable rather than as "not a mapping", because the
            // parser's message names the offending key.
            Ok(Value::Sequence(_))
            | Ok(Value::String(_))
            | Ok(Value::Number(_))
            | Ok(Value::Bool(_))
            | Ok(Value::Null) => Parse::NotAMapping,
            _ => Parse::Unparseable(err.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntitle: Welcome\ncreated: 2026-10-16T09:34:00Z\ntags: [fjord]\nfjord:\n  schema: 1\n---\n\n# Welcome\n";

    fn frontmatter_of(text: &str) -> Frontmatter {
        match parse(text) {
            Parse::Present { frontmatter, .. } => frontmatter,
            other => panic!("expected frontmatter, got {other:?}"),
        }
    }

    #[test]
    fn reads_a_conforming_doc() {
        let frontmatter = frontmatter_of(DOC);
        assert_eq!(frontmatter.id(), Some("01jagc4k7pt8y3wqnmzv5xrb7h"));
        assert_eq!(frontmatter.doc_id(), Some("01jagc4k7pt8y3wqnmzv5xrb7h"));
        assert_eq!(frontmatter.title(), Some("Welcome"));
        assert_eq!(frontmatter.created(), Some("2026-10-16T09:34:00Z"));
    }

    #[test]
    fn body_offset_points_past_the_closing_fence() {
        let body_offset = match parse(DOC) {
            Parse::Present { body_offset, .. } => body_offset,
            other => panic!("{other:?}"),
        };
        assert_eq!(&DOC[body_offset..], "\n# Welcome\n");
    }

    #[test]
    fn a_file_without_frontmatter_is_a_vault_file_not_an_error() {
        assert!(matches!(parse("# Just a heading\n"), Parse::Absent));
        assert!(matches!(parse(""), Parse::Absent));
        assert!(matches!(parse("text\n\n---\n\nmore\n"), Parse::Absent));
    }

    #[test]
    fn frontmatter_must_begin_at_byte_zero() {
        assert!(matches!(parse("\n---\nid: x\n---\n"), Parse::NotAtStart));
        assert!(matches!(
            parse("\u{feff}---\nid: x\n---\n"),
            Parse::NotAtStart
        ));
        assert!(matches!(
            parse("   \n  \n---\nid: x\n---\n"),
            Parse::NotAtStart
        ));
    }

    #[test]
    fn an_unclosed_fence_is_unterminated() {
        assert!(matches!(parse("---\nid: x\n"), Parse::Unterminated));
        assert!(matches!(parse("---\n"), Parse::Unterminated));
    }

    #[test]
    fn a_sequence_is_not_a_mapping() {
        assert!(matches!(parse("---\n- a\n- b\n---\n"), Parse::NotAMapping));
        assert!(matches!(
            parse("---\njust a string\n---\n"),
            Parse::NotAMapping
        ));
    }

    #[test]
    fn malformed_yaml_is_reported_with_its_message() {
        match parse("---\nid: [unclosed\n---\n") {
            Parse::Unparseable(message) => assert!(!message.is_empty()),
            other => panic!("expected Unparseable, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_block_is_an_empty_mapping() {
        let frontmatter = frontmatter_of("---\n---\n# Heading\n");
        assert!(frontmatter.raw().is_empty());
        assert_eq!(frontmatter.doc_id(), None);
    }

    #[test]
    fn crlf_files_parse_identically() {
        let frontmatter = frontmatter_of("---\r\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\r\n---\r\n");
        assert_eq!(frontmatter.doc_id(), Some("01jagc4k7pt8y3wqnmzv5xrb7h"));
    }

    #[test]
    fn a_malformed_id_parses_but_is_not_a_doc_id() {
        // Must not be a parse failure: the caller reports E403 against the
        // file, rather than E402 against the whole frontmatter block.
        let frontmatter = frontmatter_of("---\nid: not-a-ulid\n---\n");
        assert_eq!(frontmatter.id(), Some("not-a-ulid"));
        assert_eq!(frontmatter.doc_id(), None);
    }

    #[test]
    fn a_non_string_id_parses_too() {
        let frontmatter = frontmatter_of("---\nid: 12345\n---\n");
        assert_eq!(frontmatter.id(), None);
        assert_eq!(frontmatter.doc_id(), None);
        assert!(frontmatter.has(key::ID));
    }

    #[test]
    fn a_new_document_is_a_doc() {
        let created = "2026-10-16T09:34:00Z";
        let text = match new_document("01jagc4k7pt8y3wqnmzv5xrb7h", "Sync design", created) {
            Ok(text) => text,
            Err(err) => panic!("{err}"),
        };
        let frontmatter = frontmatter_of(&text);
        assert_eq!(frontmatter.doc_id(), Some("01jagc4k7pt8y3wqnmzv5xrb7h"));
        assert_eq!(frontmatter.title(), Some("Sync design"));
        assert_eq!(frontmatter.created(), Some(created));
        assert!(text.contains("# Sync design"));
        // §8.1: the block begins at byte 0.
        assert!(text.starts_with("---\n"));
    }

    #[test]
    fn a_title_that_would_break_yaml_is_escaped() {
        // Hand-formatting this would produce a file we would then reject.
        for title in [
            "Notes: the sequel",
            "- leading dash",
            "\"quoted\"",
            "#hash",
            "a\nnewline",
        ] {
            let text =
                match new_document("01jagc4k7pt8y3wqnmzv5xrb7h", title, "2026-10-16T09:34:00Z") {
                    Ok(text) => text,
                    Err(err) => panic!("{title:?}: {err}"),
                };
            let frontmatter = frontmatter_of(&text);
            assert_eq!(
                frontmatter.title(),
                Some(title),
                "{title:?} did not survive"
            );
            assert!(frontmatter.doc_id().is_some(), "{title:?} lost its id");
        }
    }

    #[test]
    fn a_fresh_id_replaces_only_the_id() {
        let original = "---\nzeta: 1\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntitle: Groceries\nnested:\n  keep: true\n---\n\n# Groceries\n\nmilk\n";
        let rewritten = match with_fresh_id(original, "01jagc4k7pvb6znq3xkmw9tyd5") {
            Some(rewritten) => rewritten,
            None => panic!("expected a rewrite"),
        };

        let frontmatter = frontmatter_of(&rewritten);
        assert_eq!(frontmatter.doc_id(), Some("01jagc4k7pvb6znq3xkmw9tyd5"));
        assert_eq!(frontmatter.title(), Some("Groceries"));
        // Invariant 3: every other key, in its original position.
        assert_eq!(
            frontmatter.raw().keys().collect::<Vec<&String>>(),
            vec!["zeta", "id", "title", "nested"]
        );
        // And the body is untouched.
        assert!(rewritten.ends_with("# Groceries\n\nmilk\n"));
    }

    #[test]
    fn a_file_without_frontmatter_has_no_id_to_replace() {
        assert!(with_fresh_id("# Just a heading\n", "01jagc4k7pt8y3wqnmzv5xrb7h").is_none());
    }

    #[test]
    fn a_file_with_no_frontmatter_is_promoted() {
        let original = "# Groceries\n\nmilk\n";
        let promoted = promote(
            original,
            "01jagc4k7pt8y3wqnmzv5xrb7h",
            "2026-10-16T09:34:00Z",
            "Groceries",
        )
        .expect("promote");

        let frontmatter = frontmatter_of(&promoted);
        assert_eq!(frontmatter.doc_id(), Some("01jagc4k7pt8y3wqnmzv5xrb7h"));
        assert_eq!(frontmatter.title(), Some("Groceries"));
        assert_eq!(frontmatter.created(), Some("2026-10-16T09:34:00Z"));
        // The body survives in full.
        assert!(promoted.ends_with("# Groceries\n\nmilk\n"));
    }

    #[test]
    fn promotion_keeps_what_the_file_already_said() {
        // A file from another tool brings its own metadata, which is better
        // than anything we could invent — and invariant 3 says the keys we
        // do not understand survive too.
        let original = "---\nobsidianPlugin: true\ntitle: Their Title\ncreated: 2020-01-01T00:00:00Z\ntags: [a]\n---\n\nbody\n";
        let promoted = promote(
            original,
            "01jagc4k7pt8y3wqnmzv5xrb7h",
            "2026-10-16T09:34:00Z",
            "Ours",
        )
        .expect("promote");

        let frontmatter = frontmatter_of(&promoted);
        assert_eq!(frontmatter.doc_id(), Some("01jagc4k7pt8y3wqnmzv5xrb7h"));
        assert_eq!(frontmatter.title(), Some("Their Title"));
        assert_eq!(frontmatter.created(), Some("2020-01-01T00:00:00Z"));
        assert!(frontmatter.has("obsidianPlugin"));
        assert!(frontmatter.has(key::TAGS));
    }

    #[test]
    fn a_broken_frontmatter_block_is_not_rewritten() {
        // Rewriting it would discard whatever the author meant by it.
        assert!(promote(
            "---\nid: [unclosed\n---\n",
            "01jagc4k7pt8y3wqnmzv5xrb7h",
            "x",
            "y"
        )
        .is_none());
    }

    #[test]
    fn the_implied_title_prefers_the_heading() {
        assert_eq!(
            implied_title("# Sync design\n\nbody\n", "notes.md"),
            "Sync design"
        );
        // Then the file name, §8.2's second fallback.
        assert_eq!(
            implied_title("no heading here\n", "sync-design.md"),
            "sync-design"
        );
        assert_eq!(implied_title("", "report.pdf"), "report.pdf");
        // A heading with nothing after the hash is not a title.
        assert_eq!(implied_title("#\n\nbody\n", "notes.md"), "notes");
    }

    /// Invariant 3, for documents.
    #[test]
    fn unknown_keys_and_order_survive_a_round_trip() {
        let original = "---\nzeta: 1\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\nobsidianPlugin:\n  nested: true\nalpha: [a, b]\n---\nbody\n";
        let first = frontmatter_of(original);
        let keys: Vec<&String> = first.raw().keys().collect();
        assert_eq!(keys, vec!["zeta", "id", "obsidianPlugin", "alpha"]);

        let yaml = match first.to_yaml() {
            Ok(yaml) => yaml,
            Err(err) => panic!("{err}"),
        };
        let round_tripped = frontmatter_of(&format!("---\n{yaml}---\nbody\n"));

        // A fixed point: the same keys, in the same order, with the same
        // values.
        assert_eq!(round_tripped.raw().keys().collect::<Vec<&String>>(), keys);
        assert_eq!(round_tripped.raw(), first.raw());
    }
}

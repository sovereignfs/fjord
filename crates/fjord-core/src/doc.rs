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

    const DOC: &str = "---\nid: 01JAGC4K7PT8Y3WQNMZV5XRB7H\ntitle: Welcome\ncreated: 2026-10-16T09:34:00Z\ntags: [fjord]\nfjord:\n  schema: 1\n---\n\n# Welcome\n";

    fn frontmatter_of(text: &str) -> Frontmatter {
        match parse(text) {
            Parse::Present { frontmatter, .. } => frontmatter,
            other => panic!("expected frontmatter, got {other:?}"),
        }
    }

    #[test]
    fn reads_a_conforming_doc() {
        let frontmatter = frontmatter_of(DOC);
        assert_eq!(frontmatter.id(), Some("01JAGC4K7PT8Y3WQNMZV5XRB7H"));
        assert_eq!(frontmatter.doc_id(), Some("01JAGC4K7PT8Y3WQNMZV5XRB7H"));
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
        let frontmatter = frontmatter_of("---\r\nid: 01JAGC4K7PT8Y3WQNMZV5XRB7H\r\n---\r\n");
        assert_eq!(frontmatter.doc_id(), Some("01JAGC4K7PT8Y3WQNMZV5XRB7H"));
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

    /// Invariant 3, for documents.
    #[test]
    fn unknown_keys_and_order_survive_a_round_trip() {
        let original = "---\nzeta: 1\nid: 01JAGC4K7PT8Y3WQNMZV5XRB7H\nobsidianPlugin:\n  nested: true\nalpha: [a, b]\n---\nbody\n";
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

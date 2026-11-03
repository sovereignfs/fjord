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
use crate::yaml::{self, Value};
use indexmap::IndexMap;

/// The fence that opens and closes a frontmatter block. Spec §8.1.
pub const FENCE: &str = "---";

/// Keys the specification fixes. Spec §8.1.
pub mod key {
    pub const ID: &str = "id";
    pub const TITLE: &str = "title";
    pub const CREATED: &str = "created";
    /// The moment a Doc is about, with the writer's local offset. Spec §8.1.
    pub const DATE: &str = "date";
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

    /// `date`, as written. Spec §8.1.
    pub fn date(&self) -> Option<&str> {
        self.string(key::DATE)
    }

    /// `title`, which is advisory. Spec §8.2.
    pub fn title(&self) -> Option<&str> {
        self.string(key::TITLE)
    }

    /// Serialise back to YAML, preserving key order.
    ///
    /// Used by every command that rewrites a file, and by the round-trip
    /// test that guards invariant 3.
    pub fn to_yaml(&self) -> Result<String, yaml::Error> {
        yaml::to_string(&self.raw)
    }
}

/// Build a new Doc: frontmatter plus a level-one heading. Spec §8.1.
///
/// The mapping is serialised by the YAML writer rather than formatted by
/// hand, so a title containing a colon, a quote or a leading `-` cannot
/// produce a file this crate would then refuse to parse.
pub fn new_document(id: &str, title: &str, created: &str) -> Result<String, yaml::Error> {
    let mut frontmatter: IndexMap<String, Value> = IndexMap::new();
    frontmatter.insert(key::ID.to_string(), Value::String(id.to_string()));
    frontmatter.insert(key::TITLE.to_string(), Value::String(title.to_string()));
    frontmatter.insert(key::CREATED.to_string(), Value::String(created.to_string()));

    let yaml = yaml::to_string(&frontmatter)?;
    Ok(format!("{FENCE}\n{yaml}{FENCE}\n\n# {title}\n"))
}

/// Build a new journal entry: frontmatter with its `date`, and a heading only if it has a title.
/// Spec §3.1, §8.1.
///
/// `date` is written as given, offset and all; an entry is filed and read by the writer's day.
pub fn new_entry(
    id: &str,
    title: Option<&str>,
    created: &str,
    date: &str,
) -> Result<String, yaml::Error> {
    let mut frontmatter: IndexMap<String, Value> = IndexMap::new();
    frontmatter.insert(key::ID.to_string(), Value::String(id.to_string()));
    if let Some(title) = title {
        frontmatter.insert(key::TITLE.to_string(), Value::String(title.to_string()));
    }
    frontmatter.insert(key::CREATED.to_string(), Value::String(created.to_string()));
    frontmatter.insert(key::DATE.to_string(), Value::String(date.to_string()));

    let yaml = yaml::to_string(&frontmatter)?;
    Ok(match title {
        Some(title) => format!("{FENCE}\n{yaml}{FENCE}\n\n# {title}\n"),
        None => format!("{FENCE}\n{yaml}{FENCE}\n\n"),
    })
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

    let yaml = yaml::to_string(&raw).ok()?;
    Some(format!("{FENCE}\n{yaml}{FENCE}\n{}", &text[body_offset..]))
}

/// Set a Doc's `title`, or take it away with `None`, preserving every other key and its order. Spec §8.2.
///
/// A web client's properties panel edits the title and nothing else: `id` is immutable (§8.2) and `created` is set
/// once (§8.1), so there is no function here for either. The key keeps its place when it is there; a new one goes at
/// the end of the mapping, after whatever the file already said.
///
/// The header is written again by the YAML writer, so a title with a colon, a quote or a leading `-` cannot make a
/// file this crate would refuse to read, and the comments in it are lost (§8.2 allows that; keys MUST survive). The body
/// is not touched: it is the bytes after the closing fence, as they were.
///
/// Returns `None` for a file with no frontmatter to rewrite (to give one, [`promote`] it), and for one whose
/// frontmatter is there but broken, which is not ours to rewrite.
pub fn with_title(text: &str, title: Option<&str>) -> Option<String> {
    with_key(
        text,
        key::TITLE,
        title.map(|title| Value::String(title.to_string())),
    )
}

/// A Doc's text with its `date` set, or taken away with `None`, every other key and the body as they were. Spec §8.1: `date` is
/// what an entry is about, and changing it never moves the file. `None` as [`with_title`] gives it. The date is written as given;
/// whether it is one is [`crate::scalar::is_entry_date`]'s to say, before.
pub fn with_date(text: &str, date: Option<&str>) -> Option<String> {
    with_key(
        text,
        key::DATE,
        date.map(|date| Value::String(date.to_string())),
    )
}

/// A Doc's text with its `tags` set, as written and in this order, or taken away when there are none. Spec §8.1. `None` as
/// [`with_title`] gives it.
pub fn with_tags(text: &str, tags: &[String]) -> Option<String> {
    let value = (!tags.is_empty())
        .then(|| Value::Sequence(tags.iter().cloned().map(Value::String).collect()));
    with_key(text, key::TAGS, value)
}

/// A value a form sets in a header: text, or a yes or no (a post's `draft`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldValue {
    Text(String),
    Flag(bool),
}

/// Whether a form may set the key `name`: a plain word, at most 64 characters, and not `id` (immutable, §8.2), `created` (set once, §8.1)
/// or `fjord` (a client's own state, §8.1). Any other key a file has is the person's, and a site's engine may read it.
pub fn is_settable_key(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && !matches!(name, key::ID | key::CREATED | "fjord")
}

/// A Doc's text with one key of its header set to text or a yes or no, or taken away with `None`, every other key and the body as they
/// were (spec §8.2: unknown keys MUST survive, in their order). `None` as [`with_title`] gives it, and for a key a form may not set
/// ([`is_settable_key`]).
pub fn with_field(text: &str, name: &str, value: Option<&FieldValue>) -> Option<String> {
    if !is_settable_key(name) {
        return None;
    }
    with_key(
        text,
        name,
        value.map(|value| match value {
            FieldValue::Text(text) => Value::String(text.clone()),
            FieldValue::Flag(flag) => Value::Bool(*flag),
        }),
    )
}

/// The header of `text` with one key set (where it was, or at the end) or taken away, and nothing else changed.
fn with_key(text: &str, name: &str, value: Option<Value>) -> Option<String> {
    let (frontmatter, body_offset) = match parse(text) {
        Parse::Present {
            frontmatter,
            body_offset,
        } => (frontmatter, body_offset),
        _ => return None,
    };

    let mut raw = frontmatter.raw().clone();
    match value {
        Some(value) => {
            raw.insert(name.to_string(), value);
        }
        // `shift_remove` keeps the order of the keys that are left.
        None => {
            raw.shift_remove(name);
        }
    }

    let yaml = if raw.is_empty() {
        // `---\n---\n`, which is a mapping with nothing in it (§8.1), not `{}`.
        String::new()
    } else {
        yaml::to_string(&raw).ok()?
    };
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

    let yaml = yaml::to_string(&raw).ok()?;
    Some(format!("{FENCE}\n{yaml}{FENCE}\n{body}"))
}

/// The title a document implies: its first level-one heading, else the file
/// name without its `.md`. Spec §8.2.
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
/// The YAML is parsed by [`crate::yaml`], safe Rust that constructs no arbitrary
/// objects, honours no custom tags and limits what an alias can expand to —
/// §8.1 requires a safe loader, because frontmatter is untrusted input.
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

    match yaml::read_mapping(yaml) {
        yaml::Read::Mapping(raw) => Parse::Present {
            frontmatter: Frontmatter { raw },
            body_offset,
        },
        // Valid YAML, but a sequence or a scalar.
        yaml::Read::NotAMapping => Parse::NotAMapping,
        // Not valid, or something that could not be written back exactly (a key twice, a tag, a whole number too large to be one), or a
        // mapping with a key that is not text: reported as unparseable, with the reader's message.
        yaml::Read::Invalid(err) => Parse::Unparseable(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_and_tags_are_set_and_taken_away_with_nothing_else_changed() {
        let text = "---\nzeta: 1\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\n---\n# Body\n";
        let dated = with_date(text, Some("2026-11-02T08:14:00+05:30")).unwrap_or_default();
        assert!(
            dated.starts_with("---\nzeta: 1\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ndate: "),
            "{dated}"
        );
        assert!(dated.ends_with("---\n# Body\n"));
        let tagged = with_tags(&dated, &["Work".to_string(), "project/fjord".to_string()])
            .unwrap_or_default();
        match parse(&tagged) {
            Parse::Present { frontmatter, .. } => assert_eq!(
                frontmatter.get(key::TAGS),
                Some(&Value::Sequence(vec![
                    Value::String("Work".into()),
                    Value::String("project/fjord".into())
                ]))
            ),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            with_date(&with_tags(&tagged, &[]).unwrap_or_default(), None).as_deref(),
            Some(text)
        );
        assert_eq!(with_date("no header\n", Some("2026-11-02")), None);
    }

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

    #[test]
    fn a_fj_md_name_is_titled_like_any_other_markdown_file() {
        // Spec §8.4: `.fj.md` means nothing more than `.md`, so only the `.md` comes off.
        assert_eq!(implied_title("body\n", "Q4 plan.fj.md"), "Q4 plan.fj");
        assert_eq!(implied_title("body\n", "notes.fj.txt.md"), "notes.fj.txt");
    }

    #[test]
    fn a_title_is_set_and_everything_else_stays() {
        let original = "---\nzeta: 1\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntitle: Old\nx-future:\n  - kept\n  - as is\ncreated: 2026-10-16T09:34:00Z\n---\r\n\r\n# Body\r\n\r\nline  \r\n";
        let rewritten = with_title(original, Some("New title")).expect("a rewrite");

        let frontmatter = frontmatter_of(&rewritten);
        assert_eq!(frontmatter.title(), Some("New title"));
        assert_eq!(frontmatter.doc_id(), Some("01jagc4k7pt8y3wqnmzv5xrb7h"));
        assert_eq!(frontmatter.created(), Some("2026-10-16T09:34:00Z"));
        // Invariant 3: every key, in its place, and the unknown one's value as it was.
        assert_eq!(
            frontmatter.raw().keys().collect::<Vec<&String>>(),
            vec!["zeta", "id", "title", "x-future", "created"]
        );
        assert_eq!(
            frontmatter.get("x-future"),
            frontmatter_of(original).get("x-future")
        );
        // The body is the bytes after the closing fence, CRLF and trailing spaces included.
        assert!(rewritten.ends_with("---\n\r\n# Body\r\n\r\nline  \r\n"));
    }

    #[test]
    fn a_title_that_is_new_goes_after_what_the_file_said() {
        let original = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntags: [a, b]\n---\nbody\n";
        let rewritten = with_title(original, Some("Named")).expect("a rewrite");
        assert_eq!(
            frontmatter_of(&rewritten)
                .raw()
                .keys()
                .collect::<Vec<&String>>(),
            vec!["id", "tags", "title"]
        );
        assert!(rewritten.ends_with("---\nbody\n"));
    }

    #[test]
    fn a_title_is_taken_away_and_the_other_keys_close_up() {
        let original = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntitle: Gone\nzeta: 1\n---\nbody\n";
        let rewritten = with_title(original, None).expect("a rewrite");
        let frontmatter = frontmatter_of(&rewritten);
        assert!(!frontmatter.has("title"));
        assert_eq!(
            frontmatter.raw().keys().collect::<Vec<&String>>(),
            vec!["id", "zeta"]
        );
        // Taking away what is not there changes nothing but the writing of the header.
        let again = with_title(&rewritten, None).expect("a rewrite");
        assert_eq!(frontmatter_of(&again).raw(), frontmatter.raw());
    }

    #[test]
    fn taking_away_the_only_key_leaves_an_empty_block_that_still_parses() {
        let rewritten = with_title("---\ntitle: Only\n---\nbody\n", None).expect("a rewrite");
        assert_eq!(rewritten, "---\n---\nbody\n");
        assert!(frontmatter_of(&rewritten).raw().is_empty());
    }

    #[test]
    fn a_title_that_would_break_yaml_is_written_so_that_it_reads_back_as_it_was() {
        for title in [
            "Plan: the sequel",
            "- starts like a list",
            "\"quoted\" and 'single'",
            "# not a comment",
            "line one\nline two",
            "日本語 💧 ñ",
            "  leading and trailing  ",
            "true",
            "123",
            "null",
            "[bracketed]",
            "{braced}",
            "key: value # comment",
            "---",
        ] {
            let rewritten = with_title(
                "---\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\n---\nbody\n",
                Some(title),
            )
            .expect("a rewrite");
            let frontmatter = frontmatter_of(&rewritten);
            assert_eq!(
                frontmatter.title(),
                Some(title),
                "{title:?} did not read back"
            );
            assert!(
                rewritten.ends_with("---\nbody\n"),
                "{title:?} damaged the body"
            );
        }
    }

    #[test]
    fn a_file_with_no_header_or_a_broken_one_is_not_retitled() {
        assert_eq!(with_title("just a note\n", Some("T")), None);
        assert_eq!(with_title("", Some("T")), None);
        assert_eq!(with_title("---\nnever closed\n", Some("T")), None);
        assert_eq!(with_title("---\n- a\n- list\n---\nbody\n", Some("T")), None);
        assert_eq!(
            with_title("---\nkey: [unclosed\n---\nbody\n", Some("T")),
            None
        );
        assert_eq!(with_title("\n---\nid: x\n---\n", Some("T")), None);
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

    #[test]
    fn a_field_is_set_where_it_was_or_at_the_end_and_nothing_else_moves() {
        let keys = |text: &str| -> Vec<String> {
            text.lines()
                .skip(1)
                .take_while(|line| *line != "---")
                .filter(|line| !line.starts_with(' ') && !line.starts_with('-'))
                .filter_map(|line| line.split(':').next())
                .map(String::from)
                .collect()
        };
        let text = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\nlayout: post\ntitle: Hello\ndraft: true\nx-future: [1, 2]\n---\n\nBody\n";
        let flagged = with_field(text, "draft", Some(&FieldValue::Flag(false))).expect("set");
        assert!(flagged.contains("draft: false\n") && !flagged.contains("draft: true"));
        assert_eq!(keys(&flagged), ["id", "layout", "title", "draft", "x-future"]);
        assert!(flagged.ends_with("---\n\nBody\n"));

        let described = with_field(text, "description", Some(&FieldValue::Text("A: \"post\"".into()))).expect("set");
        assert_eq!(keys(&described), ["id", "layout", "title", "draft", "x-future", "description"]);
        match parse(&described) {
            Parse::Present { frontmatter, .. } => assert_eq!(frontmatter.raw().get("description"), Some(&Value::String("A: \"post\"".into()))),
            other => panic!("not a header: {other:?}"),
        }
        // Taken away.
        let removed = with_field(text, "draft", None).expect("removed");
        assert_eq!(keys(&removed), ["id", "layout", "title", "x-future"]);
    }

    #[test]
    fn a_field_is_refused_for_a_key_a_form_may_not_set_and_for_a_file_with_no_header() {
        let text = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\n---\nbody\n";
        for name in ["id", "created", "fjord", "", "has space", "a.b", "x:y", "é"] {
            assert!(!is_settable_key(name), "{name:?}");
            assert_eq!(with_field(text, name, Some(&FieldValue::Flag(true))), None, "{name:?}");
        }
        assert!(is_settable_key("description") && is_settable_key("draft") && is_settable_key("x-future_2"));
        assert_eq!(with_field("no header\n", "draft", Some(&FieldValue::Flag(true))), None);
        assert_eq!(with_field("---\nbroken: [\n---\nbody\n", "draft", Some(&FieldValue::Flag(true))), None);
    }
}

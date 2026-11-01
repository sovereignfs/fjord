// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The YAML Fjord reads and writes: frontmatter (spec §8). Everything that touches a YAML library is here.
//!
//! Frontmatter is **untrusted input** (spec §8.1, §11.5), so the library behind this module is `serde-saphyr`: safe Rust only
//! (`#![forbid(unsafe_code)]`), with limits on alias expansion and on the size of what it will build, where the library this replaced
//! (`unsafe-libyaml`, a transliteration of the C `libyaml`) had neither.
//!
//! What is read is held as a [`Value`], a tree of the YAML core types, because a file may say anything and must come back saying the same (invariant 3,
//! spec §8.2): unknown keys, in their order. Where the library offers a choice that would **change what a file says when it is written
//! back**, this module takes the safe one and refuses the file instead, so that a block it cannot keep exactly is reported as unparseable and is not
//! rewritten (as a broken block never is):
//!
//! - **a key twice** (the library's default; the previous one kept the last and lost the first);
//! - **a tag it does not understand** (`!custom x` would be written back as `x`);
//! - **a whole number too large to be one** (it would be written back as a rounded float).
//!
//! And where YAML 1.1 and 1.2 differ it reads as 1.2 (`yes` is a string, `0o17` is a number), as the previous library did, and it **merges nothing**: a `<<` key is a key.
//! Comments are not kept, which §8.2 allows.

use indexmap::IndexMap;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_saphyr::options::{DuplicateKeyPolicy, MergeKeyPolicy, NonFiniteFloatPolicy};
use std::fmt;

/// A YAML value: the core types and nothing else. A mapping keeps its entries in order, and its keys may be any value (YAML allows it).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    /// A whole number above `i64::MAX`.
    UInt(u64),
    Float(f64),
    String(String),
    Sequence(Vec<Value>),
    Mapping(Vec<(Value, Value)>),
}

impl Value {
    /// The string a value is, if it is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }
}

/// Why YAML could not be read or written. The message is the library's, for a person to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// A whole number written as a float with at least this many digits cannot be told from one that was too large to be a whole number.
const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Reader;
        impl<'de> Visitor<'de> for Reader {
            type Value = Value;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any YAML value")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
                Ok(Value::Bool(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
                Ok(Value::Int(v))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
                Ok(match i64::try_from(v) {
                    Ok(small) => Value::Int(small),
                    Err(_) => Value::UInt(v),
                })
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
                // The library gives a whole number it cannot hold as an integer to us as a float. Writing that back would change it, so it is refused.
                if v.is_finite() && v.fract() == 0.0 && v.abs() >= TWO_POW_63 {
                    return Err(E::custom(
                        "a whole number too large to keep exactly (quote it to keep it as text)",
                    ));
                }
                Ok(Value::Float(v))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
                Ok(Value::String(v.to_string()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
                Ok(Value::String(v))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_none<E: de::Error>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_some<D2: Deserializer<'de>>(self, d: D2) -> Result<Value, D2::Error> {
                Value::deserialize(d)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Value>()? {
                    items.push(item);
                }
                Ok(Value::Sequence(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<Value, Value>()? {
                    entries.push(entry);
                }
                Ok(Value::Mapping(entries))
            }
        }
        deserializer.deserialize_any(Reader)
    }
}

/// Text with a character that readers of YAML do not agree about outside double quotes: a tab (the library writes a multi-line text as a block, and `libyaml`, which
/// other tools use, refuses a tab where a block's indentation ends), a carriage return, the line separators YAML 1.1 counted as breaks and 1.2 does not
/// (U+0085, U+2028, U+2029), a byte order mark, and the other control characters. Written in double quotes, with escapes, every reader reads the same text.
fn needs_double_quotes(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(
            c,
            '\t' | '\r' | '\u{85}' | '\u{2028}' | '\u{2029}' | '\u{feff}'
        ) || (c.is_control() && c != '\n')
    })
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(v) => serializer.serialize_bool(*v),
            Value::Int(v) => serializer.serialize_i64(*v),
            Value::UInt(v) => serializer.serialize_u64(*v),
            Value::Float(v) => serializer.serialize_f64(*v),
            Value::String(v) if needs_double_quotes(v) => {
                serde_saphyr::DoubleQuoted(v.as_str()).serialize(serializer)
            }
            Value::String(v) => serializer.serialize_str(v),
            Value::Sequence(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Value::Mapping(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

fn options() -> serde_saphyr::Options {
    // `Options` is non-exhaustive, so it is changed field by field.
    let mut options = serde_saphyr::Options::default();
    // Duplicate keys, unknown tags and merge keys all change what a file says when it is written back (see the module's note).
    options.duplicate_keys = DuplicateKeyPolicy::Error;
    options.reject_unsupported_tags = true;
    options.merge_keys = MergeKeyPolicy::AsOrdinary;
    options.non_finite_float_policy = NonFiniteFloatPolicy::PassThrough;
    // Only `true` and `false` are booleans (YAML 1.2): `yes`, `no`, `on` and `off` are text, as they were read before.
    options.strict_booleans = true;
    // One-line messages: the caller puts them in a sentence, and the source is the caller's.
    options.with_snippet = false;
    options
}

/// What YAML text is, if it is valid: a mapping with string keys (the shape of frontmatter), or why not.
#[derive(Debug)]
pub enum Read {
    Mapping(IndexMap<String, Value>),
    /// Valid YAML that is not a mapping: a sequence or a scalar.
    NotAMapping,
    /// Not valid YAML, or YAML this module will not keep exactly.
    Invalid(Error),
}

/// Read a frontmatter block's YAML.
pub fn read_mapping(yaml: &str) -> Read {
    match serde_saphyr::from_str_with_options::<Value>(yaml, options()) {
        Ok(Value::Mapping(entries)) => {
            let mut map = IndexMap::with_capacity(entries.len());
            for (key, value) in entries {
                match key {
                    Value::String(key) => {
                        map.insert(key, value);
                    }
                    // A number or a boolean as a key is the key's spelling (`1: x` is the key "1"). Anything else (a null, a float, a list) is
                    // a mapping, but not one that frontmatter can be: it is reported as unreadable, with this.
                    other => match scalar_key(&other) {
                        Some(key) => {
                            map.insert(key, value);
                        }
                        None => {
                            return Read::Invalid(Error(
                                "a key of the mapping is not text".to_string(),
                            ))
                        }
                    },
                }
            }
            Read::Mapping(map)
        }
        Ok(_) => Read::NotAMapping,
        Err(err) => Read::Invalid(Error(err.to_string())),
    }
}

/// A scalar key that is not a string, as the text a key would be: `1` is the key `"1"`, as it was with the previous library. Not a null, a
/// float or a collection, which have no one spelling to give back.
fn scalar_key(key: &Value) -> Option<String> {
    match key {
        Value::Int(v) => Some(v.to_string()),
        Value::UInt(v) => Some(v.to_string()),
        Value::Bool(v) => Some(v.to_string()),
        _ => None,
    }
}

/// Write a value as YAML.
pub fn to_string<T: Serialize>(value: &T) -> Result<String, Error> {
    serde_saphyr::to_string(value).map_err(|err| Error(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(yaml: &str) -> IndexMap<String, Value> {
        match read_mapping(yaml) {
            Read::Mapping(map) => map,
            other => panic!("expected a mapping from {yaml:?}, got {other:?}"),
        }
    }

    fn invalid(yaml: &str) -> String {
        match read_mapping(yaml) {
            Read::Invalid(err) => err.to_string(),
            other => panic!("expected {yaml:?} to be refused, got {other:?}"),
        }
    }

    fn text(value: &str) -> Value {
        Value::String(value.to_string())
    }

    // ---- What is read (YAML 1.2 core types, as the previous library read them) ----

    #[test]
    fn reads_the_core_types() {
        let map =
            mapping("a: 1\nb: 1.5\nc: true\nd: ~\ne: null\nf: text\ng: [1, two]\nh: {x: 1}\n");
        assert_eq!(map["a"], Value::Int(1));
        assert_eq!(map["b"], Value::Float(1.5));
        assert_eq!(map["c"], Value::Bool(true));
        assert_eq!(map["d"], Value::Null);
        assert_eq!(map["e"], Value::Null);
        assert_eq!(map["f"], text("text"));
        assert_eq!(map["g"], Value::Sequence(vec![Value::Int(1), text("two")]));
        assert_eq!(map["h"], Value::Mapping(vec![(text("x"), Value::Int(1))]));
    }

    #[test]
    fn reads_as_yaml_1_2_not_1_1() {
        // `yes` and `no` are text, `0o17` and `0x1F` are numbers, a date is text: a Fjord file is read the same by any tool that reads 1.2.
        let map = mapping(
            "a: yes\nb: no\nc: on\nd: 0o17\ne: 0x1F\nf: 2026-10-16\ng: 2026-10-16T09:34:00Z\n",
        );
        assert_eq!(map["a"], text("yes"));
        assert_eq!(map["b"], text("no"));
        assert_eq!(map["c"], text("on"));
        assert_eq!(map["d"], Value::Int(15));
        assert_eq!(map["e"], Value::Int(31));
        assert_eq!(map["f"], text("2026-10-16"));
        assert_eq!(map["g"], text("2026-10-16T09:34:00Z"));
    }

    #[test]
    fn numbers_are_read_as_the_library_reads_them_which_is_a_little_wider_than_1_2() {
        // Recorded, not hidden: the library takes `_` in a whole number and `0b` for binary, as YAML 1.1 and js-yaml (Obsidian's reader) do, where the
        // previous library took them for text. They are read as the numbers they are and written back as plain numbers (`1000`). A test, so that a
        // change of library that changes this is noticed.
        let map = mapping("a: 1_000\nb: 0b101\nc: +5\nd: .5\ne: 5.\n");
        assert_eq!(map["a"], Value::Int(1000));
        assert_eq!(map["b"], Value::Int(5));
        assert_eq!(map["c"], Value::Int(5));
        assert_eq!(map["d"], Value::Float(0.5));
        assert_eq!(map["e"], Value::Float(5.0));
        // Quoted, they are text, and stay as written.
        assert_eq!(mapping("a: '1_000'\n")["a"], text("1_000"));
    }

    #[test]
    fn keeps_the_order_of_the_keys() {
        let map = mapping("z: 1\na: 2\nm: 3\nb: 4\n");
        assert_eq!(
            map.keys().map(String::as_str).collect::<Vec<_>>(),
            ["z", "a", "m", "b"]
        );
    }

    #[test]
    fn a_number_or_boolean_key_is_its_spelling() {
        let map = mapping("1: one\ntrue: yes\n");
        assert_eq!(map["1"], text("one"));
        assert_eq!(map["true"], text("yes"));
    }

    #[test]
    fn an_alias_is_expanded_and_a_merge_key_is_only_a_key() {
        let map = mapping("a: &x [1, 2]\nb: *x\n<<: {c: 3}\n");
        assert_eq!(map["a"], map["b"]);
        assert_eq!(map["<<"], Value::Mapping(vec![(text("c"), Value::Int(3))]));
        assert!(!map.contains_key("c"));
    }

    #[test]
    fn non_finite_floats_are_kept() {
        let map = mapping("a: .inf\nb: -.inf\nc: .nan\n");
        assert_eq!(map["a"], Value::Float(f64::INFINITY));
        assert_eq!(map["b"], Value::Float(f64::NEG_INFINITY));
        assert!(matches!(map["c"], Value::Float(v) if v.is_nan()));
        let again = mapping(&to_string(&map).unwrap());
        assert_eq!(again["a"], Value::Float(f64::INFINITY));
        assert_eq!(again["b"], Value::Float(f64::NEG_INFINITY));
        assert!(matches!(again["c"], Value::Float(v) if v.is_nan()));
    }

    #[test]
    fn integers_at_the_edge_of_what_they_can_be_are_kept() {
        let map = mapping(
            "max: 18446744073709551615\nmin: -9223372036854775808\nsmall: 9223372036854775807\n",
        );
        assert_eq!(map["max"], Value::UInt(u64::MAX));
        assert_eq!(map["min"], Value::Int(i64::MIN));
        assert_eq!(map["small"], Value::Int(i64::MAX));
        assert_eq!(mapping(&to_string(&map).unwrap()), map);
    }

    // ---- What would change a file when it was written back is refused, so that it is not written back (invariant 3) ----

    #[test]
    fn a_key_twice_is_refused_not_resolved() {
        assert!(invalid("a: 1\nb: 2\na: 3\n").contains("duplicate"));
    }

    #[test]
    fn a_tag_it_does_not_understand_is_refused_not_dropped() {
        assert!(!invalid("a: !custom value\n").is_empty());
    }

    #[test]
    fn a_whole_number_too_large_to_be_one_is_refused_not_rounded() {
        assert!(invalid("a: 12345678901234567890123\n").contains("too large"));
        assert!(!invalid("a: -9223372036854775809\n").is_empty());
        // Quoted, it is text, and is kept.
        assert_eq!(
            mapping("a: '12345678901234567890123'\n")["a"],
            text("12345678901234567890123")
        );
    }

    #[test]
    fn a_mapping_with_a_key_that_is_not_text_is_unreadable_not_a_sequence() {
        assert!(invalid("? [a, b]\n: c\n").contains("not text"));
        assert!(matches!(read_mapping("- a\n- b\n"), Read::NotAMapping));
        assert!(matches!(read_mapping("just text"), Read::NotAMapping));
    }

    #[test]
    fn broken_yaml_is_refused_with_a_message_on_one_line() {
        let message = invalid("a: [unclosed\n");
        assert!(!message.is_empty());
        assert!(!message.trim().contains('\n'), "{message:?}");
    }

    // ---- What hostile input cannot make the library do ----

    #[test]
    fn an_alias_bomb_is_refused_not_built() {
        // Each level names the one before it ten times: a billion laughs. It must end in an error, quickly, and not in memory.
        let mut yaml = String::from("a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n");
        for level in 1..12 {
            let previous = level - 1;
            yaml.push_str(&format!(
                "a{level}: &a{level} [{}]\n",
                vec![format!("*a{previous}"); 10].join(", ")
            ));
        }
        let started = std::time::Instant::now();
        let outcome = read_mapping(&yaml);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
        assert!(matches!(outcome, Read::Invalid(_)), "{outcome:?}");
    }

    #[test]
    fn very_deep_nesting_is_refused_not_a_stack_overflow() {
        let depth = 100_000;
        let yaml = format!("a: {}{}\n", "[".repeat(depth), "]".repeat(depth));
        assert!(matches!(read_mapping(&yaml), Read::Invalid(_)));
        let block = (0..2000)
            .map(|level| format!("{}k: \n", " ".repeat(level)))
            .collect::<String>();
        let _ = read_mapping(&block); // an error or a mapping; it returns
    }

    // ---- What is written is read back as it was (invariant 3) ----

    fn round_trips(map: &IndexMap<String, Value>) {
        let written = to_string(map).unwrap_or_else(|err| panic!("could not write {map:?}: {err}"));
        match read_mapping(&written) {
            Read::Mapping(again) => assert_eq!(&again, map, "written as {written:?}"),
            other => panic!("written as {written:?}, read back as {other:?}"),
        }
    }

    #[test]
    fn text_that_looks_like_something_else_is_written_so_that_it_is_text_again() {
        let looks = [
            "true",
            "false",
            "yes",
            "no",
            "on",
            "off",
            "y",
            "n",
            "null",
            "Null",
            "NULL",
            "~",
            "",
            " ",
            "1",
            "-1",
            "+1",
            "1.5",
            "1e3",
            "0x1F",
            "0o17",
            "0b1",
            ".inf",
            "-.inf",
            ".nan",
            "2026-10-16",
            "2026-10-16T09:34:00Z",
            "12:30",
            "1_000",
            "<<",
            "=",
            "- x",
            "? x",
            ": x",
            "x: y",
            "x #y",
            "#x",
            "&x",
            "*x",
            "!x",
            "|",
            ">",
            "'",
            "\"",
            "%x",
            "@x",
            "`x",
            "{x}",
            "[x]",
            "a,b",
            " lead",
            "trail ",
            "multi\nline",
            "tab\there",
            "ends with newline\n",
            "---",
            "...",
            "💧",
            "é",
            "\u{7f}",
            "a: b: c",
        ];
        for value in looks {
            for key in [
                "plain", "id", "1", "true", "null", "x y", "- k", "k: v", "#k", "",
            ] {
                let mut map = IndexMap::new();
                map.insert(key.to_string(), text(value));
                round_trips(&map);
            }
        }
    }

    #[test]
    fn nested_values_are_written_so_that_they_read_back_the_same() {
        let nested = Value::Mapping(vec![
            (
                text("list"),
                Value::Sequence(vec![
                    Value::Int(1),
                    text("1"),
                    Value::Null,
                    text("null"),
                    Value::Bool(true),
                    text("true"),
                    Value::Float(0.5),
                    Value::Sequence(vec![]),
                    Value::Mapping(vec![]),
                ]),
            ),
            (
                text("map"),
                Value::Mapping(vec![
                    (text("a"), text("b: c")),
                    (text("2"), Value::Sequence(vec![text("- x")])),
                ]),
            ),
        ]);
        let mut map = IndexMap::new();
        map.insert("nested".to_string(), nested);
        map.insert("empty-list".to_string(), Value::Sequence(vec![]));
        map.insert("empty-map".to_string(), Value::Mapping(vec![]));
        map.insert("float".to_string(), Value::Float(1.0));
        map.insert("negative-zero".to_string(), Value::Float(-0.0));
        round_trips(&map);
    }

    /// A small deterministic generator, so that a failure is the same failure next time.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn random_text(rng: &mut Rng) -> String {
        const PIECES: &[&str] = &[
            "a",
            "b",
            "Z",
            "0",
            "1",
            "9",
            " ",
            "  ",
            "\t",
            "\n",
            ":",
            ": ",
            "-",
            "- ",
            "?",
            "? ",
            "#",
            " #",
            "&",
            "*",
            "!",
            "|",
            ">",
            "'",
            "\"",
            "\\",
            "%",
            "@",
            "`",
            ",",
            "[",
            "]",
            "{",
            "}",
            "~",
            ".",
            "e",
            "x",
            "true",
            "false",
            "null",
            "yes",
            "no",
            "on",
            "0x",
            "1e3",
            ".inf",
            ".nan",
            "2026-10-16",
            "T",
            "Z",
            "---",
            "...",
            "é",
            "💧",
            "\u{a0}",
            "\u{2028}",
            "<<",
            "=",
            "_",
            "+",
        ];
        (0..rng.below(8))
            .map(|_| PIECES[rng.below(PIECES.len())])
            .collect()
    }

    fn random_value(rng: &mut Rng, depth: usize) -> Value {
        match rng.below(if depth >= 3 { 6 } else { 8 }) {
            0 => Value::Null,
            1 => Value::Bool(rng.below(2) == 0),
            2 => Value::Int(rng.next() as i64 >> rng.below(60)),
            3 => Value::Float((rng.next() as i64 >> 20) as f64 / 64.0),
            4 | 5 => Value::String(random_text(rng)),
            6 => Value::Sequence(
                (0..rng.below(4))
                    .map(|_| random_value(rng, depth + 1))
                    .collect(),
            ),
            _ => Value::Mapping(
                (0..rng.below(4))
                    .map(|i| {
                        (
                            Value::String(format!("{}{i}", random_text(rng))),
                            random_value(rng, depth + 1),
                        )
                    })
                    .collect(),
            ),
        }
    }

    #[test]
    fn whatever_is_written_is_read_back_as_it_was() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for case in 0..20_000 {
            let mut map = IndexMap::new();
            for i in 0..=rng.below(5) {
                map.insert(
                    format!("{}{i}", random_text(&mut rng)),
                    random_value(&mut rng, 0),
                );
            }
            let written = to_string(&map)
                .unwrap_or_else(|err| panic!("case {case}: could not write {map:?}: {err}"));
            match read_mapping(&written) {
                Read::Mapping(again) => {
                    assert_eq!(again, map, "case {case}, written as {written:?}")
                }
                other => panic!("case {case}: written as {written:?}, read back as {other:?}"),
            }
        }
    }

    #[test]
    fn writing_what_was_read_is_a_fixed_point() {
        // parse -> write -> parse -> write: the second write is the first (a file rewritten twice does not drift).
        let mut rng = Rng(0x1234_5678_9abc_def1);
        for case in 0..5_000 {
            let mut map = IndexMap::new();
            for i in 0..=rng.below(4) {
                map.insert(
                    format!("{}{i}", random_text(&mut rng)),
                    random_value(&mut rng, 0),
                );
            }
            let once = to_string(&map).unwrap();
            let Read::Mapping(read) = read_mapping(&once) else {
                panic!("case {case}: {once:?}")
            };
            assert_eq!(to_string(&read).unwrap(), once, "case {case}");
        }
    }
}

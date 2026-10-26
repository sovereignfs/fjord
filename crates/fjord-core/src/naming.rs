// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Naming a note from what was typed. Spec §5 decides which names are valid;
//! this decides which valid name a new note gets.
//!
//! A client that captures a thought before it has asked for a name — a phone's
//! quick note, a share sheet — names the file from its first line, so that the
//! repository is readable without Fjord. Every client uses this function, so a
//! note typed on a phone and one typed in a browser get the same name:
//!
//! 1. Take the **first line** of the text.
//! 2. Strip the Markdown that makes a line something other than a title:
//!    headings (`#`), quotes (`>`), list markers (`-`, `*`, `+`, `1.`, `1)`)
//!    and task boxes (`[ ]`, `[x]`), however they are stacked.
//! 3. Make it a name: every character spec §5 forbids, every control character
//!    and every run of whitespace becomes a single space, backticks go, and
//!    leading and trailing spaces and dots are trimmed. The result is NFC.
//! 4. Cut it at [`MAX_NAME_CHARS`] characters, on a word boundary where there
//!    is one.
//! 5. A line with nothing left to name a file by (empty, or only markers and
//!    punctuation) gives the date and time instead: `2026-10-22 1430`.
//! 6. A name Windows reserves is prefixed with `Note `.
//! 7. A name already taken in the folder, **by any entry that differs only by
//!    case** (spec §5 rule 6), gets ` 2`, ` 3`, … before the extension.
//!
//! The function is pure: it has no clock, so the caller supplies the local
//! date and time for the fallback, and no view of a folder, so the caller
//! supplies the names in it.

use crate::path::{is_reserved_device_name, to_nfc, FORBIDDEN_CHARACTERS};
use std::collections::HashSet;

/// The longest a name made from text is, before the extension and any
/// ` 2` that disambiguates it. In characters, not bytes: 60 characters are at
/// most 240 bytes, which leaves room under the 255 of spec §5 rule 5.
pub const MAX_NAME_CHARS: usize = 60;

/// The extension of a note. (A *document* is `.fj.md`, spec §8.4, and is not
/// named this way: it is made on purpose, with a title.)
pub const NOTE_EXTENSION: &str = ".md";

/// A moment in the writer's own time zone, to the minute. The caller reads it
/// from a clock, because this crate has none.
///
/// The fields are written as given, zero-padded, so a value out of range
/// still makes a valid name; it is for the caller to give a real date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalMinute {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
}

/// `2026-10-22 1430`: the name of a note with nothing to name it by.
pub fn date_time_stem(when: LocalMinute) -> String {
    format!(
        "{:04}-{:02}-{:02} {:02}{:02}",
        when.year, when.month, when.day, when.hour, when.minute
    )
}

/// The file name for a new note typed as `text`, given the names already in
/// the folder it is going into (every entry, files and directories, with
/// their extensions). Ends in [`NOTE_EXTENSION`].
///
/// Always a valid component (spec §5), never one of `existing` — compared
/// case-insensitively and after NFC — and never empty.
pub fn quick_note_name<S: AsRef<str>>(text: &str, existing: &[S], now: LocalMinute) -> String {
    let stem = title_from_text(text).unwrap_or_else(|| date_time_stem(now));
    free_name(&stem, NOTE_EXTENSION, existing)
}

/// The name a note's first line asks for, without extension, or `None` when
/// there is nothing in it to name a file by. Steps 1–4 and 6 of the module
/// documentation.
pub fn title_from_text(text: &str) -> Option<String> {
    let line = text.lines().next().unwrap_or("");
    let stripped = strip_markers(line);

    // Anything spec §5 forbids, control characters (a tab among them) and
    // whitespace is a single space between words.
    let mut stem = String::with_capacity(stripped.len());
    let mut gap = false;
    for c in stripped.chars() {
        if c == '`' {
            continue;
        }
        if c.is_whitespace() || c.is_control() || FORBIDDEN_CHARACTERS.contains(&c) {
            gap = true;
            continue;
        }
        if gap && !stem.is_empty() {
            stem.push(' ');
        }
        gap = false;
        stem.push(c);
    }
    let stem = to_nfc(trim_name(&stem));

    // After the cut, which can leave a reserved word on its own ("CON plan for the quarter" cut to "CON"). The
    // prefix is cut again, so the limit holds. `con.txt notes.md` is the device `con` on Windows, as `CON.md` is.
    let stem = cut(&stem, MAX_NAME_CHARS);
    let stem = if is_reserved_device_name(&format!("{stem}{NOTE_EXTENSION}")) {
        cut(&format!("Note {stem}"), MAX_NAME_CHARS)
    } else {
        stem
    };

    // Punctuation alone (`---`, `***`, `...`) is not a title. Other scripts and symbols are: a note titled with
    // one emoji is named by it. Asked of what is left, since a cut can leave nothing of a title that began with
    // characters that name nothing.
    stem.chars().any(names_something).then_some(stem)
}

/// `stem` plus `extension` if no entry of `existing` has that name, else
/// `stem 2`, `stem 3`, … plus `extension`: the first that is free.
///
/// "Has that name" is spec §5 rule 6: names that differ only by case are the
/// same name, since a case-insensitive filesystem would collapse them. Names
/// are compared in NFC, so an `existing` name from a filesystem that hands out
/// NFD still matches.
pub fn free_name<S: AsRef<str>>(stem: &str, extension: &str, existing: &[S]) -> String {
    let taken: HashSet<String> = existing.iter().map(|name| fold(name.as_ref())).collect();
    let first = format!("{stem}{extension}");
    if !taken.contains(&fold(&first)) {
        return first;
    }
    (2u64..)
        .map(|n| format!("{stem} {n}{extension}"))
        .find(|candidate| !taken.contains(&fold(candidate)))
        .unwrap_or(first)
}

/// What makes two names the same for spec §5 rule 6 — the same fold
/// [`case_collisions`](crate::path::case_collisions) uses, after NFC.
fn fold(name: &str) -> String {
    to_nfc(name).to_lowercase()
}

/// Whether a character can name a file on its own: a letter or digit of any
/// script, or a symbol outside ASCII, but not a joiner, a variation selector
/// or a combining mark, which only mean something next to another character.
fn names_something(c: char) -> bool {
    if c.is_alphanumeric() {
        return true;
    }
    !c.is_ascii()
        && !is_invisible(c)
        && !matches!(c as u32, 0x0300..=0x036f /* combining diacritics */)
}

/// Characters that are not seen: zero-width space and joiners, direction marks and controls, the word joiner,
/// variation selectors and the byte order mark. Meaningful inside a name (a joiner holds an emoji sequence
/// together), never at either end of it.
fn is_invisible(c: char) -> bool {
    matches!(
        c as u32,
        0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x2064 | 0xfe00..=0xfe0f | 0xfeff
    )
}

/// Spaces and dots at either end go: a trailing one is invalid (spec §5
/// rule 3) and a leading dot makes a hidden file.
fn trim_name(name: &str) -> &str {
    name.trim_matches(|c: char| c == ' ' || c == '.' || is_invisible(c))
}

/// The line without the Markdown that is not part of what it says.
fn strip_markers(line: &str) -> &str {
    let mut rest = line;
    loop {
        let trimmed = rest.trim_start();
        let next = if let Some(after) = trimmed.strip_prefix('#') {
            after.trim_start_matches('#')
        } else if let Some(after) = trimmed.strip_prefix('>') {
            after
        } else if let Some(after) = list_marker(trimmed) {
            after
        } else if let Some(after) = task_box(trimmed) {
            after
        } else {
            return trimmed;
        };
        rest = next;
    }
}

/// `- `, `* `, `+ `, `12. ` and `12) `, as a prefix.
fn list_marker(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    match chars.next()? {
        '-' | '*' | '+' => {
            let after = chars.as_str();
            (after.is_empty() || after.starts_with(char::is_whitespace)).then_some(after)
        }
        c if c.is_ascii_digit() => {
            let digits = line.chars().take_while(char::is_ascii_digit).count();
            let after = &line[digits..];
            let after = after
                .strip_prefix('.')
                .or_else(|| after.strip_prefix(')'))?;
            (digits <= 9 && (after.is_empty() || after.starts_with(char::is_whitespace)))
                .then_some(after)
        }
        _ => None,
    }
}

/// `[ ]`, `[x]` and `[X]`, as a prefix.
fn task_box(line: &str) -> Option<&str> {
    ["[ ]", "[x]", "[X]"]
        .iter()
        .find_map(|marker| line.strip_prefix(marker))
}

/// At most `max` characters of `stem`, ending between words when it can: the
/// last whole word that fits, or, for a single word longer than `max`, a hard
/// cut. What is left is trimmed again, and a joiner or variation selector the
/// cut left dangling goes with it (it can leave nothing: the caller asks).
fn cut(stem: &str, max: usize) -> String {
    let chars: Vec<char> = stem.chars().collect();
    if chars.len() <= max {
        return stem.to_string();
    }
    let head: String = chars[..max].iter().collect();
    let on_a_boundary = chars[max] == ' ';
    let kept = if on_a_boundary {
        head.as_str()
    } else {
        match head.rfind(' ') {
            Some(at) => &head[..at],
            None => head.as_str(),
        }
    };
    trim_name(kept).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::check_component;

    const WHEN: LocalMinute = LocalMinute {
        year: 2026,
        month: 10,
        day: 22,
        hour: 14,
        minute: 30,
    };
    const NONE: &[&str] = &[];

    fn name(text: &str) -> String {
        quick_note_name(text, NONE, WHEN)
    }

    #[test]
    fn the_first_line_names_the_note() {
        assert_eq!(name("Buy milk"), "Buy milk.md");
        assert_eq!(
            name("Buy milk\nand eggs, and a long second line"),
            "Buy milk.md"
        );
        assert_eq!(name("Buy milk\r\nand eggs"), "Buy milk.md");
    }

    #[test]
    fn markdown_markers_are_stripped_however_they_are_stacked() {
        assert_eq!(name("# Plan for Q4"), "Plan for Q4.md");
        assert_eq!(name("###### Deep"), "Deep.md");
        assert_eq!(name("#hashtag"), "hashtag.md");
        assert_eq!(name("- buy milk"), "buy milk.md");
        assert_eq!(name("* buy milk"), "buy milk.md");
        assert_eq!(name("+ buy milk"), "buy milk.md");
        assert_eq!(name("  - [ ] buy milk"), "buy milk.md");
        assert_eq!(name("- [x] done thing"), "done thing.md");
        assert_eq!(name("- [X] done thing"), "done thing.md");
        assert_eq!(name("> - [ ] quoted task"), "quoted task.md");
        assert_eq!(name("1. first"), "first.md");
        assert_eq!(name("12) twelfth"), "twelfth.md");
        assert_eq!(
            name("## 1. Heading with a number"),
            "Heading with a number.md"
        );
    }

    #[test]
    fn a_number_that_is_a_title_is_not_a_list() {
        // No space after the dot: `3.5` is a number, `2026-10-22` a date.
        assert_eq!(name("3.5 litres"), "3.5 litres.md");
        assert_eq!(name("2026-10-22 standup"), "2026-10-22 standup.md");
        assert_eq!(name("1234567890. ten digits"), "1234567890. ten digits.md");
        // `-5` is not a list item, and nor is `*bold*`.
        assert_eq!(name("-5 degrees"), "-5 degrees.md");
    }

    #[test]
    fn what_spec_5_forbids_becomes_a_space() {
        assert_eq!(name("Q4: plan/budget"), "Q4 plan budget.md");
        assert_eq!(name("what? why* how\\ <ok> |\"x\""), "what why how ok x.md");
        assert_eq!(name("a\tb\u{0}c"), "a b c.md");
        assert_eq!(name("**bold** and `code`"), "bold and code.md");
        assert_eq!(
            name("https://example.com/a?b=c"),
            "https example.com a b=c.md"
        );
    }

    #[test]
    fn whitespace_collapses_and_the_ends_are_trimmed() {
        assert_eq!(name("   a    b   "), "a b.md");
        assert_eq!(name("Hello..."), "Hello.md");
        assert_eq!(name("Hello . ."), "Hello.md");
        assert_eq!(name(".hidden thing"), "hidden thing.md");
        assert_eq!(name("v1.2 plan"), "v1.2 plan.md");
    }

    #[test]
    fn the_name_is_nfc() {
        let nfd = "cafe\u{301}";
        let named = name(nfd);
        assert_eq!(named, "caf\u{e9}.md");
        assert!(check_component(&named).is_empty());
    }

    #[test]
    fn it_is_cut_at_60_characters_on_a_word_boundary() {
        let words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
        let named = name(words);
        // 60 characters would end inside "juliet"; the last whole word that fits is kept.
        assert_eq!(
            named,
            "alpha bravo charlie delta echo foxtrot golf hotel india.md"
        );
        assert!(named.trim_end_matches(".md").chars().count() <= MAX_NAME_CHARS);

        // The cut falls exactly after a word: that word is kept whole, and the rest dropped.
        let exact = format!("{} tail", "x".repeat(60));
        assert_eq!(name(&exact), format!("{}.md", "x".repeat(60)));
        // Exactly 60 characters is not cut at all.
        let fits = format!("{} abcd", "x".repeat(55));
        assert_eq!(name(&fits), format!("{} abcd.md", "x".repeat(55)));
        // One more and the last word goes.
        let over = format!("{} abcde", "x".repeat(55));
        assert_eq!(name(&over), format!("{}.md", "x".repeat(55)));
    }

    #[test]
    fn one_very_long_word_is_cut_hard() {
        let named = name(&"a".repeat(200));
        assert_eq!(named, format!("{}.md", "a".repeat(MAX_NAME_CHARS)));
    }

    #[test]
    fn it_counts_characters_and_stays_under_the_byte_limit() {
        let named = name(&"é".repeat(100));
        assert_eq!(
            named.trim_end_matches(".md").chars().count(),
            MAX_NAME_CHARS
        );
        let named = name(&"漢".repeat(100));
        assert_eq!(
            named.trim_end_matches(".md").chars().count(),
            MAX_NAME_CHARS
        );
        assert!(check_component(&named).is_empty());
        // Four-byte characters: 60 of them are 240 bytes, and ".md" still fits under 255.
        let named = name(&"😀".repeat(100));
        assert!(check_component(&named).is_empty(), "{named}");
    }

    #[test]
    fn a_cut_does_not_leave_a_joiner_dangling() {
        // "x" repeated, then a family emoji built with zero-width joiners, cut inside it.
        let text = format!("{}👨\u{200d}👩\u{200d}👧", "x".repeat(58));
        let named = name(&text);
        let stem = named.trim_end_matches(".md");
        assert!(!stem.ends_with('\u{200d}'), "{stem:?}");
        assert!(check_component(&named).is_empty());
    }

    #[test]
    fn nothing_to_name_it_by_gives_the_date_and_time() {
        for text in [
            "", "\n", "   ", "#", "###", "---", "***", "- [ ]", "...", "?!", "`",
        ] {
            assert_eq!(name(text), "2026-10-22 1430.md", "{text:?}");
        }
        // Only the first line counts: a blank first line is an empty title.
        assert_eq!(name("\nthe real text"), "2026-10-22 1430.md");
    }

    #[test]
    fn a_symbol_or_another_script_is_a_name() {
        assert_eq!(name("🎉"), "🎉.md");
        assert_eq!(name("# 買い物リスト"), "買い物リスト.md");
        assert_eq!(name("Привет, мир"), "Привет, мир.md");
        // Joiners, variation selectors and lone combining marks name nothing.
        for text in [
            "\u{200d}",
            "\u{fe0f}",
            "\u{301}",
            "\u{feff} ",
            "\u{200b}\u{200d}",
        ] {
            assert_eq!(name(text), "2026-10-22 1430.md", "{text:?}");
        }
    }

    #[test]
    fn the_date_and_time_is_zero_padded() {
        let early = LocalMinute {
            year: 2026,
            month: 1,
            day: 2,
            hour: 3,
            minute: 4,
        };
        assert_eq!(quick_note_name("", NONE, early), "2026-01-02 0304.md");
        assert_eq!(date_time_stem(early), "2026-01-02 0304");
    }

    #[test]
    fn a_name_windows_reserves_is_not_used_as_it_is() {
        assert_eq!(name("con"), "Note con.md");
        assert_eq!(name("NUL"), "Note NUL.md");
        assert_eq!(name("# lpt1"), "Note lpt1.md");
        // The device is the part before the first dot, whatever follows.
        assert_eq!(name("con.txt ideas"), "Note con.txt ideas.md");
        // A cut can leave one on its own: the long title is not reserved, the first word of it is.
        let long = format!("CON {}", "a".repeat(70));
        assert_eq!(name(&long), "Note CON.md");
        // A name that merely starts with one is not reserved.
        assert_eq!(name("console"), "console.md");
        assert_eq!(name("com10"), "com10.md");
        assert_eq!(name("con tent"), "con tent.md");
    }

    #[test]
    fn a_taken_name_gets_a_number_before_the_extension() {
        let existing = ["Buy milk.md"];
        assert_eq!(
            quick_note_name("Buy milk", &existing, WHEN),
            "Buy milk 2.md"
        );
        let existing = ["Buy milk.md", "Buy milk 2.md", "Buy milk 4.md"];
        assert_eq!(
            quick_note_name("Buy milk", &existing, WHEN),
            "Buy milk 3.md"
        );
        let existing = ["Buy milk.md", "Buy milk 2.md", "Buy milk 3.md"];
        assert_eq!(
            quick_note_name("Buy milk", &existing, WHEN),
            "Buy milk 4.md"
        );
    }

    #[test]
    fn a_name_that_differs_only_by_case_is_taken() {
        assert_eq!(
            quick_note_name("Buy milk", &["BUY MILK.md"], WHEN),
            "Buy milk 2.md"
        );
        assert_eq!(
            quick_note_name("Buy milk", &["buy milk.MD"], WHEN),
            "Buy milk 2.md"
        );
        assert_eq!(
            quick_note_name("Buy milk", &["Buy milk.md", "BUY MILK 2.md"], WHEN),
            "Buy milk 3.md"
        );
        // An unrelated or merely similar name does not count.
        assert_eq!(
            quick_note_name("Buy milk", &["Buy milk 2", "Buy milkshake.md"], WHEN),
            "Buy milk.md"
        );
    }

    #[test]
    fn a_name_in_nfd_on_disk_is_the_same_name() {
        let existing = ["cafe\u{301}.md"];
        assert_eq!(
            quick_note_name("caf\u{e9}", &existing, WHEN),
            "caf\u{e9} 2.md"
        );
    }

    #[test]
    fn the_date_and_time_fallback_is_numbered_too() {
        assert_eq!(
            quick_note_name("", &["2026-10-22 1430.md"], WHEN),
            "2026-10-22 1430 2.md"
        );
    }

    #[test]
    fn a_directory_of_the_same_name_counts() {
        // `existing` is every entry; a folder called "Buy milk.md" blocks the file.
        assert_eq!(
            quick_note_name("Buy milk", &["Buy milk.md"], WHEN),
            "Buy milk 2.md"
        );
    }

    #[test]
    fn it_is_the_same_every_time() {
        let a = quick_note_name("# A title: with things", &["x.md"], WHEN);
        let b = quick_note_name("# A title: with things", &["x.md"], WHEN);
        assert_eq!(a, b);
    }

    #[test]
    fn free_name_works_for_any_stem_and_extension() {
        assert_eq!(
            free_name("report", ".fj.md", &["report.fj.md"]),
            "report 2.fj.md"
        );
        assert_eq!(
            free_name("report", ".fj.md", &["report.md"]),
            "report.fj.md"
        );
    }

    /// A small deterministic generator (SplitMix64), so the property test below needs no dependency and fails
    /// the same way every time.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// Pieces chosen to break every rule at once: markers, forbidden characters, controls, whitespace,
    /// dots, device names, NFD, joiners, wide and combining characters, and long words.
    const PIECES: &[&str] = &[
        "#",
        "##",
        "-",
        "- ",
        "* ",
        "+ ",
        "> ",
        "[ ]",
        "[x]",
        "1. ",
        "12) ",
        " ",
        "  ",
        "\t",
        "\n",
        "\r\n",
        "\u{0}",
        "\u{1f}",
        "/",
        "\\",
        ":",
        "*",
        "?",
        "\"",
        "<",
        ">",
        "|",
        ".",
        "..",
        "...",
        "`",
        "con",
        "CON",
        "nul.txt",
        "Lpt1",
        "com9",
        "a",
        "B",
        "word",
        "Word",
        "milk",
        "é",
        "e\u{301}",
        "ß",
        "İ",
        "漢字",
        "😀",
        "👨\u{200d}👩\u{200d}👧",
        "\u{fe0f}",
        "\u{200d}",
        "x",
        "1",
        "2026-10-22",
        "3.5",
        "---",
        "***",
        "averyveryveryveryveryverylongwordwithnospacesatalltomakethecuthard",
        "  trailing ",
        "\u{301}",
    ];

    fn random_text(rng: &mut Rng) -> String {
        let n = rng.below(14);
        (0..n).map(|_| PIECES[rng.below(PIECES.len())]).collect()
    }

    /// Spec §5 holds for every name this makes, and no name it makes is one it was given, whatever the
    /// text and whatever the folder holds (ROADMAP MP2).
    #[test]
    fn every_name_is_valid_and_never_collides_with_the_names_it_was_given() {
        let mut rng = Rng(0x00F1_0ED0);
        for case in 0..20_000 {
            let text = random_text(&mut rng);

            // A folder that holds random names, and names that differ from the answer only by case or
            // normalisation, so that the numbering has to run.
            let mut existing: Vec<String> =
                (0..rng.below(6)).map(|_| random_text(&mut rng)).collect();
            let alone = quick_note_name(&text, NONE, WHEN);
            for n in 0..rng.below(4) {
                let blocked = if n == 0 {
                    alone.clone()
                } else {
                    alone.replacen(".md", &format!(" {}.md", n + 1), 1)
                };
                existing.push(match rng.below(3) {
                    0 => blocked.to_uppercase(),
                    1 => blocked.to_lowercase(),
                    _ => blocked,
                });
            }

            let named = quick_note_name(&text, &existing, WHEN);

            let problems = check_component(&named);
            assert!(
                problems.is_empty(),
                "case {case}: {text:?} -> {named:?} breaks {problems:?}"
            );
            assert!(named.ends_with(NOTE_EXTENSION), "case {case}: {named:?}");
            let stem = named.strip_suffix(NOTE_EXTENSION).unwrap_or("");
            assert!(
                !stem.is_empty(),
                "case {case}: {text:?} -> {named:?} existing {existing:?}"
            );
            assert!(!stem.starts_with(['.', ' ']), "case {case}: {named:?}");
            assert!(!stem.contains("  "), "case {case}: {named:?}");
            assert!(
                named.len() <= 255 && named.len() <= 4 * MAX_NAME_CHARS + 16,
                "case {case}: {named:?}"
            );
            assert!(
                !is_reserved_device_name(&named),
                "case {case}: {text:?} -> {named:?} is a device name"
            );
            let taken: Vec<String> = existing.iter().map(|e| fold(e)).collect();
            assert!(
                !taken.contains(&fold(&named)),
                "case {case}: {text:?} -> {named:?} is taken by {existing:?}"
            );
            // With nothing in the folder the name is cut to the limit; numbering adds only " N".
            let bare = alone.strip_suffix(NOTE_EXTENSION).unwrap_or("");
            assert!(
                bare.chars().count() <= MAX_NAME_CHARS.max(date_time_stem(WHEN).len()),
                "case {case}: {alone:?}"
            );
        }
    }
}

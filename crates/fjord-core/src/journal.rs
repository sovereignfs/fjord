// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Where a journal's new entry goes. Spec §3.1, §8.1, §11.2.
//!
//! An entry is a Fjord Doc with a `date`; nothing else makes it one, and its path is a convention for
//! making entries, not a rule. When the path and `date` disagree, `date` wins, and the mismatch is never
//! a diagnostic.
//!
//! The day and time in the path are those of the `date` **as written**, at the writer's own offset, so
//! that an entry written just after midnight is filed under that day and not the previous one in UTC.
//! No clock and no time zone are read here: the caller writes the `date` first
//! ([`crate::scalar::rfc3339_from_unix_at_offset`]) and asks where it goes.

use crate::path::to_nfc;

/// The longest slug [`slug`] makes, in characters: enough to say what an entry is, short enough to keep
/// the path well under spec §5's limits.
pub const SLUG_MAX_CHARS: usize = 60;

/// A slug for an entry's name, from its title: lowercase, letters and digits of any script, words joined
/// by `-`. `None` when nothing is left, and the entry is named by its time alone.
///
/// Everything a path rule forbids (§5) is a separator here, so the result is always a valid name, and
/// the time in front of it means it can never be a Windows device name.
pub fn slug(title: &str) -> Option<String> {
    let mut out = String::new();
    let mut length = 0;
    let mut gap = false;
    for character in to_nfc(title).to_lowercase().chars() {
        if !character.is_alphanumeric() {
            gap = true;
            continue;
        }
        let separator = gap && !out.is_empty();
        if length + usize::from(separator) + 1 > SLUG_MAX_CHARS {
            break;
        }
        if separator {
            out.push('-');
            length += 1;
        }
        gap = false;
        out.push(character);
        length += 1;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Where a new entry dated `date` goes, relative to the journal's vault, or `None` when `date` is not an RFC 3339 date-time (a
/// full-date alone has no time to name the entry by): `YYYY-MM-DD/hh-mm.md`, a folder for each day and a file named by the minute the
/// entry was made, both in the writer's own time. The same name is used in an encrypted journal, where it is the name inside the
/// container and the folder is the one directory name that is not hidden (§11.2): the days with entries are visible, by the owner's
/// choice, and nothing else about them is. The title is not in the path: it is in the entry.
pub fn entry_path(date: &str) -> Option<String> {
    use time::format_description::well_known::Rfc3339;

    let at = time::OffsetDateTime::parse(date, &Rfc3339).ok()?;
    let (year, month, day) = (at.year(), u8::from(at.month()), at.day());
    if !(0..=9999).contains(&year) {
        return None;
    }
    Some(format!(
        "{year:04}-{month:02}-{day:02}/{:02}-{:02}.md",
        at.hour(),
        at.minute()
    ))
}

/// Where an entry falls on a journal's timeline: its day and, if known, its time, both in the writer's own time, and what said so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct When {
    /// `YYYY-MM-DD`.
    pub day: String,
    /// `HH:MM`, when the source has a time.
    pub time: Option<String>,
    pub source: WhenSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhenSource {
    /// The entry's `date`, which always wins (spec §8.1).
    Date,
    /// Its path, by the convention [`entry_path`] files by, when it has no `date` that can be read.
    Path,
    /// Its `created`, in UTC, the last resort.
    Created,
}

impl When {
    /// A key that sorts entries by when they are about, as the writer lived it: `YYYY-MM-DDTHH:MM`, a day alone before its times.
    pub fn sort_key(&self) -> String {
        match &self.time {
            Some(time) => format!("{}T{time}", self.day),
            None => self.day.clone(),
        }
    }
}

/// When an entry is about (spec §8.1): its `date`, else the date its path is filed under (`YYYY/MM/DD/HHMM…` or
/// `YYYY-MM-DD-HHMM…`, relative to the vault), else its `created`. `None` when none of them says. A `date` that is not one is
/// passed over here; that it is not is a warning ([`crate::diagnostics::Code::InvalidDate`]).
pub fn when(date: Option<&str>, path: &str, created: Option<&str>) -> Option<When> {
    use time::format_description::well_known::Rfc3339;

    let at = |moment: &time::OffsetDateTime, source| When {
        day: format!(
            "{:04}-{:02}-{:02}",
            moment.year(),
            u8::from(moment.month()),
            moment.day()
        ),
        time: Some(format!("{:02}:{:02}", moment.hour(), moment.minute())),
        source,
    };
    if let Some(date) = date {
        if let Ok(moment) = time::OffsetDateTime::parse(date, &Rfc3339) {
            return Some(at(&moment, WhenSource::Date));
        }
        if crate::scalar::is_full_date(date) {
            return Some(When {
                day: date.to_string(),
                time: None,
                source: WhenSource::Date,
            });
        }
    }
    if let Some(found) = from_path(path) {
        return Some(found);
    }
    let created =
        created.and_then(|created| time::OffsetDateTime::parse(created, &Rfc3339).ok())?;
    Some(at(&created, WhenSource::Created))
}

/// The day and time a path is filed under by [`entry_path`]'s convention, or by the layouts journals were filed in before it.
fn from_path(path: &str) -> Option<When> {
    let digits = |text: &str, length: usize| {
        text.len() == length && text.bytes().all(|b| b.is_ascii_digit())
    };
    let parts: Vec<&str> = path.split('/').collect();
    // `YYYY-MM-DD/HH-MM…` (what [`entry_path`] makes), `YYYY/MM/DD/HHMM…` at the end of the path, or `YYYY-MM-DD-HHMM…` as its last part:
    // the last two are what journals made before were filed by, and still read.
    let (year, month, day, rest) = match parts.as_slice() {
        [.., folder, leaf]
            if folder.len() == 10
                && digits(&folder[0..4], 4)
                && &folder[4..5] == "-"
                && digits(&folder[5..7], 2)
                && &folder[7..8] == "-"
                && digits(&folder[8..10], 2)
                && leaf.len() >= 5
                && digits(&leaf[0..2], 2)
                && &leaf[2..3] == "-"
                && digits(&leaf[3..5], 2) =>
        {
            (&folder[0..4], &folder[5..7], &folder[8..10], *leaf)
        }
        [.., year, month, day, leaf] if digits(year, 4) && digits(month, 2) && digits(day, 2) => {
            (*year, *month, *day, *leaf)
        }
        [.., leaf]
            if leaf.len() >= 10
                && digits(&leaf[0..4], 4)
                && &leaf[4..5] == "-"
                && digits(&leaf[5..7], 2)
                && &leaf[7..8] == "-"
                && digits(&leaf[8..10], 2) =>
        {
            (
                &leaf[0..4],
                &leaf[5..7],
                &leaf[8..10],
                leaf[10..].trim_start_matches('-'),
            )
        }
        _ => return None,
    };
    let full = format!("{year}-{month}-{day}");
    if !crate::scalar::is_full_date(&full) {
        return None;
    }
    // `HH-MM` or `HHMM`, at the start of the leaf.
    let time = rest
        .get(0..5)
        .filter(|hhmm| digits(&hhmm[0..2], 2) && &hhmm[2..3] == "-" && digits(&hhmm[3..5], 2))
        .map(|hhmm| (&hhmm[0..2], &hhmm[3..5]))
        .or_else(|| {
            rest.get(0..4)
                .filter(|hhmm| digits(hhmm, 4))
                .map(|hhmm| (&hhmm[0..2], &hhmm[2..4]))
        })
        .and_then(|(hour, minute)| {
            (hour < "24" && minute < "60").then(|| format!("{hour}:{minute}"))
        });
    Some(When {
        day: full,
        time,
        source: WhenSource::Path,
    })
}

/// What a journal's timeline shows of one entry, from its text and its path in the vault: a Doc's id, its title (the header's, else
/// its first heading, else its name, spec §8.2), its `date` as written and whether it is one, its tags as written (the text ones;
/// spec §8.1), when it is about ([`when`]), and the start of its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub doc_id: Option<String>,
    pub title: String,
    pub date: Option<String>,
    /// A `date` is there but is not one: the warning [`crate::diagnostics::Code::InvalidDate`].
    pub date_invalid: bool,
    pub tags: Vec<String>,
    pub when: Option<When>,
    pub excerpt: String,
    /// A post that is not for the site yet: `draft: true` in its header (Astro), or a path in Jekyll's `_drafts` (spec §3.1).
    pub draft: bool,
}

/// How much of an entry's text a timeline shows, in characters.
pub const EXCERPT_CHARS: usize = 160;

/// [`Summary`] of the entry `text` at `path` (relative to the vault).
pub fn summary(text: &str, path: &str) -> Summary {
    let leaf = path.rsplit('/').next().unwrap_or(path);
    let (frontmatter, body) = match crate::doc::parse(text) {
        crate::doc::Parse::Present {
            frontmatter,
            body_offset,
        } => (Some(frontmatter), &text[body_offset..]),
        _ => (None, text),
    };
    // Spec §8.2: the header's `title` first, else the first level-one heading, else the file name.
    let title = match frontmatter
        .as_ref()
        .and_then(|f| f.title())
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        Some(title) => title.to_string(),
        None => crate::doc::implied_title(text, leaf),
    };
    let date_value = frontmatter
        .as_ref()
        .and_then(|f| f.get(crate::doc::key::DATE));
    let date = date_value
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let date_invalid =
        date_value.is_some() && !date.as_deref().is_some_and(crate::scalar::is_entry_date);
    let tags = match frontmatter
        .as_ref()
        .and_then(|f| f.get(crate::doc::key::TAGS))
    {
        Some(crate::yaml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    let created = frontmatter.as_ref().and_then(|f| f.created());
    // The text after a first heading that is the title, its words run together.
    let mut lines = body
        .lines()
        .skip_while(|line| line.trim().is_empty())
        .peekable();
    if lines.peek().is_some_and(|line| line.starts_with("# ")) {
        lines.next();
    }
    let mut excerpt = String::new();
    for word in lines.flat_map(str::split_whitespace) {
        if excerpt.chars().count() + word.chars().count() + 1 > EXCERPT_CHARS {
            excerpt.push('…');
            break;
        }
        if !excerpt.is_empty() {
            excerpt.push(' ');
        }
        excerpt.push_str(word);
    }
    let draft = path.split('/').any(|part| part == "_drafts")
        || matches!(
            frontmatter.as_ref().and_then(|f| f.get("draft")),
            Some(crate::yaml::Value::Bool(true))
        );
    Summary {
        draft,
        doc_id: frontmatter
            .as_ref()
            .and_then(|f| f.doc_id())
            .map(str::to_string),
        title,
        when: when(date.as_deref().filter(|_| !date_invalid), path, created),
        date,
        date_invalid,
        tags,
        excerpt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_is_filed_by_the_writer_s_day_and_time() {
        assert_eq!(
            entry_path("2026-11-03T14:30:59+05:30").as_deref(),
            Some("2026-11-03/14-30.md")
        );
        assert_eq!(
            entry_path("2026-11-02T08:14:00+05:30").as_deref(),
            Some("2026-11-02/08-14.md")
        );
    }

    /// The reason `date` keeps its offset: half past midnight in Colombo is still the 1st in UTC, and
    /// the entry belongs to the 2nd.
    #[test]
    fn just_after_midnight_is_the_new_day_whatever_the_utc_date() {
        assert_eq!(
            entry_path("2026-11-02T00:30:00+05:30").as_deref(),
            Some("2026-11-02/00-30.md")
        );
        assert_eq!(
            entry_path("2026-11-01T23:30:00-08:00").as_deref(),
            Some("2026-11-01/23-30.md")
        );
    }

    #[test]
    fn the_path_has_one_folder_and_a_file_named_by_the_time_and_nothing_of_the_title() {
        let path = entry_path("2026-11-02T08:14:00+05:30").unwrap_or_default();
        assert_eq!(path.matches('/').count(), 1);
        assert!(path.ends_with("08-14.md"));
    }

    #[test]
    fn a_date_with_no_time_names_no_entry() {
        assert_eq!(entry_path("2026-11-02"), None);
        assert_eq!(entry_path("2026-11-02 08:14:00 +0530"), None);
        assert_eq!(entry_path(""), None);
    }

    #[test]
    fn a_path_is_read_in_the_layout_it_is_made_in_and_in_the_two_before_it() {
        let at = |path| when(None, path, None).map(|w| (w.sort_key(), w.source));
        let path = Some(("2026-11-02T08:14".to_string(), WhenSource::Path));
        assert_eq!(at("2026-11-02/08-14.md"), path);
        assert_eq!(at("journal/2026-11-02/08-14.md"), path);
        assert_eq!(at("2026/11/02/0814-run.md"), path);
        assert_eq!(at("2026-11-02-0814-run.md"), path);
        assert_eq!(
            at("2026-11-02/notes.md"),
            None,
            "a folder named by a day is not enough to name a time"
        );
    }

    #[test]
    fn an_entry_is_placed_by_its_date_then_its_path_then_its_created() {
        let at = |date, path, created| when(date, path, created).map(|w| (w.sort_key(), w.source));
        // `date` wins over a path that disagrees with it.
        assert_eq!(
            at(
                Some("2026-11-02T00:30:00+05:30"),
                "2025/01/01/0900.md",
                None
            ),
            Some(("2026-11-02T00:30".to_string(), WhenSource::Date))
        );
        assert_eq!(
            at(Some("2026-11-01"), "x.md", None),
            Some(("2026-11-01".to_string(), WhenSource::Date))
        );
        // A date that is not one is passed over.
        assert_eq!(
            at(
                Some("2026-11-02 08:14:00 +0530"),
                "2026/11/02/0814-run.md",
                None
            ),
            Some(("2026-11-02T08:14".to_string(), WhenSource::Path))
        );
        assert_eq!(
            at(None, "2026-11-02-0814-run.md", None),
            Some(("2026-11-02T08:14".to_string(), WhenSource::Path))
        );
        assert_eq!(
            at(None, "old/2026/11/02/notes.md", None),
            Some(("2026-11-02".to_string(), WhenSource::Path))
        );
        assert_eq!(
            at(None, "inbox/idea.md", Some("2026-11-01T19:00:00Z")),
            Some(("2026-11-01T19:00".to_string(), WhenSource::Created))
        );
        assert_eq!(at(None, "2026/13/40/0814.md", None), None);
        assert_eq!(at(None, "idea.md", None), None);
    }

    /// Spec §8.2: a title in the header is the title, whatever the body begins with. A site's posts have no heading, since the layout prints it.
    #[test]
    fn the_headers_title_comes_before_a_heading_and_a_file_name() {
        let post = "---\ntitle: Hello, World!\ndate: 2026-11-02\n---\n\nNo heading here.\n";
        assert_eq!(summary(post, "posts/hello-world.md").title, "Hello, World!");
        let both = "---\ntitle: In the header\n---\n\n# In the body\n";
        assert_eq!(summary(both, "a.md").title, "In the header");
        assert_eq!(
            summary("---\ntitle: \"  \"\n---\n\n# Heading\n", "a.md").title,
            "Heading"
        );
        assert_eq!(
            summary(
                "---\ndate: 2026-11-02\n---\n\nbody\n",
                "posts/hello-world.md"
            )
            .title,
            "hello-world"
        );
    }

    #[test]
    fn a_summary_is_what_the_timeline_shows() {
        let text = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb9c\ndate: 2026-11-02T08:14:00+05:30\ntags: [Health, 3, running]\n---\n\n# Morning run\n\nFive   kilometres\nbefore the rain.\n";
        let made = summary(text, "2026/11/02/0814-morning-run.md");
        assert_eq!(made.doc_id.as_deref(), Some("01jagc4k7pt8y3wqnmzv5xrb9c"));
        assert_eq!(made.title, "Morning run");
        assert_eq!(made.tags, ["Health", "running"]);
        assert!(!made.date_invalid);
        assert_eq!(made.excerpt, "Five kilometres before the rain.");
        assert_eq!(
            made.when.map(|w| w.sort_key()).as_deref(),
            Some("2026-11-02T08:14")
        );

        assert!(!made.draft);
        assert!(summary("---\ndraft: true\n---\nx\n", "posts/a.md").draft);
        assert!(summary("---\ntitle: t\n---\nx\n", "_drafts/a.md").draft);
        assert!(!summary("---\ndraft: false\n---\nx\n", "posts/a.md").draft);

        let jekyll = summary(
            "---\ndate: 2026-11-02 08:14:00 +0530\n---\nx\n",
            "2026/11/01/0900.md",
        );
        assert!(jekyll.date_invalid);
        assert_eq!(jekyll.when.map(|w| w.source), Some(WhenSource::Path));
        let long = summary(&"word ".repeat(100), "a.md");
        assert!(long.excerpt.chars().count() <= EXCERPT_CHARS + 1 && long.excerpt.ends_with('…'));
    }

    #[test]
    fn a_slug_is_lowercase_words_of_any_script() {
        assert_eq!(slug("Morning run").as_deref(), Some("morning-run"));
        assert_eq!(
            slug("  Q4: plan / review?  ").as_deref(),
            Some("q4-plan-review")
        );
        assert_eq!(slug("Café — à demain").as_deref(), Some("café-à-demain"));
        assert_eq!(slug("日記 二日目").as_deref(), Some("日記-二日目"));
        assert_eq!(slug("?!…"), None);
        assert_eq!(slug(""), None);
    }

    #[test]
    fn a_slug_is_always_a_valid_name() {
        let long = "word ".repeat(40);
        let made = slug(&long).unwrap_or_default();
        assert!(made.chars().count() <= SLUG_MAX_CHARS);
        assert!(!made.ends_with('-'));
        for title in [
            "CON",
            "a:b*c?d\"e<f>g|h\\i/j",
            "trailing dot.",
            "tab\there",
            &long,
        ] {
            if let Some(slug) = slug(title) {
                let name = format!("0814-{slug}.md");
                assert!(
                    crate::path::check_component(&name).is_empty(),
                    "{title:?} gave {name:?}"
                );
            }
        }
    }
}

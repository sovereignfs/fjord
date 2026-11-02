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

/// How a journal files its entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// `YYYY/MM/DD/HHMM[-slug].md`, for a plaintext journal.
    Dated,
    /// `YYYY-MM-DD-HHMM[-slug].md` at the vault's root, for an encrypted journal: directory names are
    /// never encrypted (§11.2), and dated folders would show which days have entries. With
    /// `fileNaming` `"id"` this name is the one inside the container, which only a reader with the key
    /// sees.
    Flat,
}

impl Layout {
    /// The layout for a journal whose vault is, or is not, encrypted.
    pub fn for_vault(encrypted: bool) -> Self {
        if encrypted {
            Layout::Flat
        } else {
            Layout::Dated
        }
    }
}

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

/// Where a new entry dated `date` goes, relative to the journal's vault, or `None` when `date` is not
/// an RFC 3339 date-time. A full-date alone has no time to name the entry by.
///
/// `slug` is used as it is given; make one with [`slug`].
pub fn entry_path(date: &str, slug: Option<&str>, layout: Layout) -> Option<String> {
    use time::format_description::well_known::Rfc3339;

    let at = time::OffsetDateTime::parse(date, &Rfc3339).ok()?;
    let (year, month, day) = (at.year(), u8::from(at.month()), at.day());
    if !(0..=9999).contains(&year) {
        return None;
    }
    let time = format!("{:02}{:02}", at.hour(), at.minute());
    let leaf = match slug.filter(|slug| !slug.is_empty()) {
        Some(slug) => format!("{time}-{slug}.md"),
        None => format!("{time}.md"),
    };
    Some(match layout {
        Layout::Dated => format!("{year:04}/{month:02}/{day:02}/{leaf}"),
        Layout::Flat => format!("{year:04}-{month:02}-{day:02}-{leaf}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_is_filed_by_the_writer_s_day_and_time() {
        assert_eq!(
            entry_path(
                "2026-11-02T08:14:00+05:30",
                Some("morning-run"),
                Layout::Dated
            )
            .as_deref(),
            Some("2026/11/02/0814-morning-run.md")
        );
        assert_eq!(
            entry_path("2026-11-02T08:14:59+05:30", None, Layout::Dated).as_deref(),
            Some("2026/11/02/0814.md")
        );
    }

    /// The reason `date` keeps its offset: half past midnight in Colombo is still the 1st in UTC, and
    /// the entry belongs to the 2nd.
    #[test]
    fn just_after_midnight_is_the_new_day_whatever_the_utc_date() {
        assert_eq!(
            entry_path("2026-11-02T00:30:00+05:30", None, Layout::Dated).as_deref(),
            Some("2026/11/02/0030.md")
        );
        assert_eq!(
            entry_path("2026-11-01T23:30:00-08:00", None, Layout::Dated).as_deref(),
            Some("2026/11/01/2330.md")
        );
    }

    #[test]
    fn an_encrypted_journal_has_no_dated_folders() {
        assert_eq!(Layout::for_vault(true), Layout::Flat);
        assert_eq!(
            entry_path("2026-11-02T08:14:00+05:30", Some("run"), Layout::Flat).as_deref(),
            Some("2026-11-02-0814-run.md")
        );
        let path = entry_path("2026-11-02T08:14:00+05:30", None, Layout::Flat).unwrap_or_default();
        assert!(!path.contains('/'));
    }

    #[test]
    fn a_date_with_no_time_names_no_entry() {
        assert_eq!(entry_path("2026-11-02", None, Layout::Dated), None);
        assert_eq!(
            entry_path("2026-11-02 08:14:00 +0530", None, Layout::Dated),
            None
        );
        assert_eq!(entry_path("", None, Layout::Dated), None);
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

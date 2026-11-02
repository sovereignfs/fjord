// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Where a site's new post goes, and what it says. Spec §3.1; Research 0001, *What both engines need*.
//!
//! The content model is fixed per engine, on purpose (RFC 0001): a post has a title, a `date`, `tags`, and is a draft or not. What
//! differs is how an engine says so, and two of those are the engine's rules and not Fjord's convention:
//!
//! - **Astro** reads `content/posts/<slug>.md` and the post's own `draft` field, which the scaffold's pages filter on. The file name is
//!   its address, so it carries no date.
//! - **Jekyll** reads `content/_posts/YYYY-MM-DD-<slug>.md`, whose name **is** a rule: a name that does not begin with a date is not a
//!   post. A draft is a file in `content/_drafts/<slug>.md` instead. Its tags are a list of words, and "a tag with a space" is two
//!   tags to Jekyll, so a tag with whitespace in it is refused for it.
//!
//! The day in a Jekyll name is the writer's, from the `date` as written (spec §8.1), as a journal entry's is.

use crate::manifest::Engine;
use crate::yaml::{self, Value};
use indexmap::IndexMap;

/// The slug a post with no title is named by.
pub const UNTITLED: &str = "untitled";

/// Where a new post goes, relative to the site's vault, or `None` when `date` is not a date or the engine is not one this build knows.
///
/// `title` is turned into a slug as a journal entry's is ([`crate::journal::slug`]), or [`UNTITLED`]. A draft is Jekyll's `_drafts`; for
/// Astro it is a field of the post, so its path is the same.
pub fn post_path(engine: &Engine, date: &str, title: &str, draft: bool) -> Option<String> {
    let slug = crate::journal::slug(title).unwrap_or_else(|| UNTITLED.to_string());
    match engine {
        Engine::Astro => crate::scalar::is_entry_date(date).then(|| format!("posts/{slug}.md")),
        Engine::Jekyll if draft => {
            crate::scalar::is_entry_date(date).then(|| format!("_drafts/{slug}.md"))
        }
        Engine::Jekyll => {
            let when = crate::journal::when(Some(date), "", None)?;
            Some(format!("_posts/{}-{slug}.md", when.day))
        }
        Engine::Unknown(_) => None,
    }
}

/// A new post's text: `id`, `title` if there is one, `created`, `date`, and for Astro a draft's `draft: true` (Jekyll's drafts are a
/// folder). No heading in the body: both scaffolds' layouts print the title.
pub fn new_post(
    engine: &Engine,
    id: &str,
    title: &str,
    created: &str,
    date: &str,
    draft: bool,
) -> Result<String, yaml::Error> {
    use crate::doc::key;
    let mut header: IndexMap<String, Value> = IndexMap::new();
    header.insert(key::ID.to_string(), Value::String(id.to_string()));
    if !title.trim().is_empty() {
        header.insert(
            key::TITLE.to_string(),
            Value::String(title.trim().to_string()),
        );
    }
    header.insert(key::CREATED.to_string(), Value::String(created.to_string()));
    header.insert(key::DATE.to_string(), Value::String(date.to_string()));
    if draft && *engine == Engine::Astro {
        header.insert("draft".to_string(), Value::Bool(true));
    }
    Ok(format!("---\n{}---\n\n", yaml::to_string(&header)?))
}

/// Why `tag` cannot be a tag of a post of this engine, in words for a person, or `None` when it can. Jekyll reads `tags` as words:
/// one with whitespace in it would be two.
pub fn tag_problem(engine: &Engine, tag: &str) -> Option<&'static str> {
    match engine {
        Engine::Jekyll if tag.chars().any(char::is_whitespace) => {
            Some("Jekyll reads a tag with a space in it as two tags. Use a hyphen, or write it as one word.")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn astro_names_a_post_by_its_title_alone() {
        assert_eq!(
            post_path(
                &Engine::Astro,
                "2026-11-02T08:14:00+05:30",
                "Hello, World!",
                false
            )
            .as_deref(),
            Some("posts/hello-world.md")
        );
        assert_eq!(
            post_path(&Engine::Astro, "2026-11-02", "", true).as_deref(),
            Some("posts/untitled.md")
        );
    }

    /// The reason a Jekyll post's name is a rule: it begins with the day, and the day is the writer's.
    #[test]
    fn a_jekyll_post_s_name_follows_its_date_in_the_writer_s_day() {
        assert_eq!(
            post_path(
                &Engine::Jekyll,
                "2026-11-02T00:30:00+05:30",
                "First light",
                false
            )
            .as_deref(),
            Some("_posts/2026-11-02-first-light.md")
        );
        assert_eq!(
            post_path(&Engine::Jekyll, "2026-11-01", "Day alone", false).as_deref(),
            Some("_posts/2026-11-01-day-alone.md")
        );
        assert_eq!(
            post_path(&Engine::Jekyll, "2026-11-02", "Not yet", true).as_deref(),
            Some("_drafts/not-yet.md")
        );
    }

    #[test]
    fn a_date_that_is_not_one_or_an_engine_not_known_names_no_post() {
        assert_eq!(post_path(&Engine::Jekyll, "yesterday", "x", false), None);
        assert_eq!(
            post_path(&Engine::Astro, "2026-11-02 08:14:00 +0530", "x", false),
            None
        );
        assert_eq!(
            post_path(&Engine::Unknown("hugo".into()), "2026-11-02", "x", false),
            None
        );
    }

    #[test]
    fn a_post_s_header_has_what_the_engine_reads() {
        let astro = new_post(
            &Engine::Astro,
            "01jagc4k7pt8y3wqnmzv5xrb9c",
            "Hi",
            "2026-11-01T19:00:00Z",
            "2026-11-02T00:30:00+05:30",
            true,
        )
        .unwrap_or_default();
        assert!(
            astro.starts_with("---\nid: 01jagc4k7pt8y3wqnmzv5xrb9c\ntitle: Hi\ncreated:"),
            "{astro}"
        );
        assert!(
            astro.contains("draft: true\n") && astro.ends_with("---\n\n"),
            "{astro}"
        );
        // Jekyll's draft is a folder, so the post says nothing of it.
        let jekyll = new_post(
            &Engine::Jekyll,
            "01jagc4k7pt8y3wqnmzv5xrb9c",
            "",
            "2026-11-01T19:00:00Z",
            "2026-11-02",
            true,
        )
        .unwrap_or_default();
        assert!(
            !jekyll.contains("draft") && !jekyll.contains("title"),
            "{jekyll}"
        );
    }

    #[test]
    fn a_tag_with_a_space_is_refused_for_jekyll_only() {
        assert!(tag_problem(&Engine::Jekyll, "two words").is_some());
        assert!(tag_problem(&Engine::Jekyll, "tab\there").is_some());
        assert_eq!(tag_problem(&Engine::Jekyll, "project/fjord"), None);
        assert_eq!(tag_problem(&Engine::Astro, "two words"), None);
    }
}

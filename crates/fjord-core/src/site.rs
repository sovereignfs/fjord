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

// --- Images (RFC 0004) ---------------------------------------------------------------------------------------------------------

/// The image types a site's library takes, told apart by their first bytes and never by a name (RFC 0004). SVG is not one: it is a
/// document that can carry script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageType {
    Png,
    Jpeg,
    Webp,
    Gif,
    Avif,
}

impl ImageType {
    /// The extension a file of this type is given, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Gif => "gif",
            Self::Avif => "avif",
        }
    }

    /// The media type a file of this type is served as.
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
            Self::Avif => "image/avif",
        }
    }
}

/// The type `bytes` are, by their first bytes, or `None` when they are not an image this library takes (SVG and anything else).
pub fn image_type(bytes: &[u8]) -> Option<ImageType> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageType::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageType::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageType::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageType::Webp)
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        Some(ImageType::Avif)
    } else {
        None
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Where a site's library keeps its images, relative to the repository's root, given the directory of the site's vault (`""` for a
/// vault at the root), or `None` for an engine this build does not know.
///
/// Inside the vault, as `images/`, for Astro and for a Jekyll vault Jekyll serves from. **A Jekyll vault under a directory that
/// begins with `_`** (an adopted site whose vault is `_posts`) cannot hold images: Jekyll skips such directories (RFC 0004, P18), so
/// they go to `assets/images/`, which Jekyll serves, at the root. That is the one exception to "inside the vault".
pub fn image_dir(engine: &Engine, vault_dir: &str) -> Option<String> {
    match engine {
        Engine::Astro => Some(join(vault_dir, "images")),
        Engine::Jekyll if vault_dir.split('/').any(|part| part.starts_with('_')) => {
            Some("assets/images".to_string())
        }
        Engine::Jekyll => Some(join(vault_dir, "images")),
        Engine::Unknown(_) => None,
    }
}

/// The longest stem of an uploaded image's name.
const IMAGE_STEM_MAX: usize = 64;

/// The name an uploaded image is given: its own, lowercased and in NFC, spaces and anything outside `a-z 0-9 . _ -` turned into `-`,
/// the extension from its type, and `-2`, `-3` and on when `existing` (the names already in the folder) has one that differs only by
/// case. The same name given again is the same name, and it never holds a separator, `..` or a Windows device name (spec §5).
pub fn image_name(file_name: &str, kind: ImageType, existing: &[String]) -> String {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or("");
    let stem = match base.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => base,
    };
    let mut clean = String::new();
    let mut gap = false;
    for character in crate::path::to_nfc(stem).to_lowercase().chars() {
        if matches!(character, 'a'..='z' | '0'..='9' | '.' | '_') {
            if gap && !clean.is_empty() {
                clean.push('-');
            }
            gap = false;
            clean.push(character);
        } else {
            gap = true;
        }
    }
    let mut clean = clean.trim_matches(['.', '_']).to_string();
    clean.truncate(IMAGE_STEM_MAX);
    while clean.ends_with(['.', '-']) {
        clean.pop();
    }
    if clean.is_empty() || crate::path::is_reserved_device_name(&clean) {
        clean = format!("image-{clean}").trim_end_matches('-').to_string();
    }
    let taken = |name: &str| existing.iter().any(|e| e.eq_ignore_ascii_case(name));
    let extension = kind.extension();
    let mut name = format!("{clean}.{extension}");
    let mut n = 2;
    while taken(&name) {
        name = format!("{clean}-{n}.{extension}");
        n += 1;
    }
    name
}

/// The directory part of a repository path, `""` for a file at the root.
fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// `path` with its `.` and `..` resolved, or `None` when it goes above the root.
fn resolve(path: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            other => out.push(other),
        }
    }
    Some(out.join("/"))
}

/// How the post at `post_path` refers to the image at `image_path` (both relative to the repository's root), in the form its engine
/// reads: Astro a path relative to the post (`../images/x.webp`, which its image pipeline resolves and optimises), Jekyll a path from
/// the site's root (`/content/images/x.png`, as it copies a static file). `None` for an engine this build does not know.
pub fn image_ref(engine: &Engine, post_path: &str, image_path: &str) -> Option<String> {
    match engine {
        Engine::Astro => {
            let from: Vec<&str> = dir_of(post_path)
                .split('/')
                .filter(|p| !p.is_empty())
                .collect();
            let to: Vec<&str> = image_path.split('/').filter(|p| !p.is_empty()).collect();
            let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
            let ups = from.len() - common;
            let rest = to[common..].join("/");
            Some(if ups == 0 {
                format!("./{rest}")
            } else {
                format!("{}{rest}", "../".repeat(ups))
            })
        }
        Engine::Jekyll => Some(format!("/{}", image_path.trim_start_matches('/'))),
        Engine::Unknown(_) => None,
    }
}

/// The destination of every Markdown image (`![alt](destination "title")`) in `body`, in order, as written.
pub fn image_refs(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find("![") {
        rest = &rest[at + 2..];
        let mut depth = 1;
        let mut close = None;
        for (i, c) in rest.char_indices() {
            match c {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(i);
                        break;
                    }
                }
                '\n' if rest[..i].ends_with('\n') => break,
                _ => {}
            }
        }
        let Some(close) = close else { break };
        let after = &rest[close + 1..];
        rest = after;
        let Some(inner) = after.strip_prefix('(') else {
            continue;
        };
        let inner = inner.trim_start();
        let destination = if let Some(angled) = inner.strip_prefix('<') {
            angled.split('>').next().unwrap_or("")
        } else {
            inner.split([' ', '\t', '\n', ')']).next().unwrap_or("")
        };
        if !destination.is_empty() {
            found.push(destination.to_string());
        }
    }
    found
}

/// Whether the post at `post_path`, whose text after its header is `body`, shows the image at `image_path`: some Markdown image of it
/// resolves to that path, from the post for a relative destination and from the site's root for one that begins with `/`. A
/// destination with a scheme, a query or a fragment is its path alone; one that leaves the repository refers to nothing.
pub fn refers_to(post_path: &str, body: &str, image_path: &str) -> bool {
    image_refs(body).iter().any(|destination| {
        if destination.contains("://")
            || destination.starts_with("//")
            || destination.starts_with("data:")
        {
            return false;
        }
        let bare = destination.split(['?', '#']).next().unwrap_or("");
        let full = match bare.strip_prefix('/') {
            Some(root) => root.to_string(),
            None => join(dir_of(post_path), bare),
        };
        resolve(&full).is_some_and(|resolved| resolved == image_path)
    })
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

    // --- Images (RFC 0004) ---

    #[test]
    fn an_image_is_what_its_first_bytes_say() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some(ImageType::Png));
        assert_eq!(
            image_type(&[0xFF, 0xD8, 0xFF, 0xE0, 0]),
            Some(ImageType::Jpeg)
        );
        assert_eq!(image_type(b"GIF89a.."), Some(ImageType::Gif));
        assert_eq!(
            image_type(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some(ImageType::Webp)
        );
        assert_eq!(
            image_type(b"\x00\x00\x00\x1cftypavif\x00"),
            Some(ImageType::Avif)
        );
        // A PNG named .jpg is a PNG, and a document is not an image, SVG included.
        assert_eq!(
            image_type(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            None
        );
        assert_eq!(image_type(b"<html><script>alert(1)</script>"), None);
        assert_eq!(image_type(b""), None);
        assert_eq!(image_type(b"RIFF\x00\x00\x00\x00WAVEfmt "), None);
        assert_eq!(image_type(b"\x00\x00\x00\x1cftypmp42\x00"), None);
    }

    #[test]
    fn an_images_folder_is_inside_the_vault_unless_jekyll_cannot_serve_it() {
        assert_eq!(
            image_dir(&Engine::Astro, "content").as_deref(),
            Some("content/images")
        );
        assert_eq!(
            image_dir(&Engine::Astro, "src/content").as_deref(),
            Some("src/content/images")
        );
        assert_eq!(
            image_dir(&Engine::Jekyll, "content").as_deref(),
            Some("content/images")
        );
        // P18: Jekyll skips a directory that begins with an underscore, so a vault that is `_posts` keeps its images beside it.
        assert_eq!(
            image_dir(&Engine::Jekyll, "_posts").as_deref(),
            Some("assets/images")
        );
        assert_eq!(
            image_dir(&Engine::Jekyll, "docs/_posts").as_deref(),
            Some("assets/images")
        );
        assert_eq!(image_dir(&Engine::Unknown("hugo".into()), "content"), None);
    }

    #[test]
    fn an_image_is_named_safely_and_never_over_another() {
        let none: Vec<String> = Vec::new();
        assert_eq!(
            image_name("My Holiday Photo.JPG", ImageType::Jpeg, &none),
            "my-holiday-photo.jpg"
        );
        // The extension follows the bytes, not the name.
        assert_eq!(image_name("shot.jpg", ImageType::Png, &none), "shot.png");
        assert_eq!(
            image_name("../../etc/passwd", ImageType::Png, &none),
            "passwd.png"
        );
        assert_eq!(
            image_name("a\\b\\c d.png", ImageType::Png, &none),
            "c-d.png"
        );
        assert_eq!(image_name("..", ImageType::Png, &none), "image.png");
        assert_eq!(image_name("日本語.png", ImageType::Png, &none), "image.png");
        assert_eq!(
            image_name("con.png", ImageType::Png, &none),
            "image-con.png"
        );
        assert_eq!(image_name("--x--.png", ImageType::Png, &none), "x.png");
        let taken = vec!["Photo.png".to_string(), "photo-2.png".to_string()];
        assert_eq!(
            image_name("photo.png", ImageType::Png, &taken),
            "photo-3.png"
        );
        // Fixed point: a name this function made is the name it makes again.
        let once = image_name("My  Pic (1).PNG", ImageType::Png, &none);
        assert_eq!(image_name(&once, ImageType::Png, &none), once);
        assert!(!once.contains('/') && !once.contains(".."), "{once}");
        let long = "x".repeat(300);
        assert!(image_name(&long, ImageType::Png, &none).len() <= IMAGE_STEM_MAX + 4);
    }

    #[test]
    fn a_post_refers_to_an_image_in_its_engine_s_form_and_the_reference_resolves_back() {
        let a = Engine::Astro;
        assert_eq!(
            image_ref(&a, "content/posts/p.md", "content/images/x.png").as_deref(),
            Some("../images/x.png")
        );
        assert_eq!(
            image_ref(&a, "src/content/posts/a/b/p.md", "src/content/images/x.png").as_deref(),
            Some("../../../images/x.png")
        );
        assert_eq!(
            image_ref(&a, "content/p.md", "content/images/x.png").as_deref(),
            Some("./images/x.png")
        );
        let j = Engine::Jekyll;
        assert_eq!(
            image_ref(&j, "content/_posts/2026-11-08-p.md", "content/images/x.png").as_deref(),
            Some("/content/images/x.png")
        );
        assert_eq!(
            image_ref(&j, "_posts/2026-11-08-p.md", "assets/images/x.png").as_deref(),
            Some("/assets/images/x.png")
        );
        assert_eq!(
            image_ref(&Engine::Unknown("hugo".into()), "p.md", "x.png"),
            None
        );
        // The round trip, at several depths.
        for (engine, post, image) in [
            (&a, "content/posts/p.md", "content/images/x.png"),
            (
                &a,
                "src/content/posts/2026/p.md",
                "src/content/images/x.png",
            ),
            (&a, "content/p.md", "content/images/x.png"),
            (&j, "content/_posts/2026-11-08-p.md", "content/images/x.png"),
            (&j, "_posts/2026-11-08-p.md", "assets/images/x.png"),
        ] {
            let reference = image_ref(engine, post, image).unwrap_or_default();
            assert!(
                refers_to(post, &format!("text ![alt]({reference})"), image),
                "{post} {reference}"
            );
        }
    }

    #[test]
    fn the_images_a_body_shows_are_found_as_written() {
        let body = "![one](a.png) text ![two](<b c.png> \"title\") ![three](../d.png \'t\')\n![nested [x]](e.png)\n![none]\n![](f.png)";
        assert_eq!(
            image_refs(body),
            ["a.png", "b c.png", "../d.png", "e.png", "f.png"]
        );
        assert!(image_refs("no images [link](x.png)").is_empty());
    }

    #[test]
    fn a_reference_is_to_the_image_only_if_it_resolves_to_it() {
        let post = "content/posts/p.md";
        let image = "content/images/x.png";
        assert!(refers_to(post, "![a](../images/x.png)", image));
        assert!(refers_to(post, "![a](../images/x.png?v=2#top)", image));
        assert!(refers_to(post, "![a](/content/images/x.png)", image));
        assert!(!refers_to(post, "![a](../images/y.png)", image));
        assert!(!refers_to(post, "![a](images/x.png)", image));
        assert!(!refers_to(
            post,
            "![a](https://example.com/content/images/x.png)",
            image
        ));
        assert!(!refers_to(post, "![a](../../../../images/x.png)", image));
        assert!(!refers_to(post, "[a](../images/x.png)", image));
    }
}

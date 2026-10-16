//! `fjord ls` — what is in the repository. Spec §8.
//!
//! A plain listing reads **no** document contents, so it needs no identity
//! and decrypts nothing: in a `fileNaming: "plain"` vault the names are
//! already visible to anyone who can read the repository (§11.2), and
//! listing them is not a privileged act.
//!
//! `--long` and `--json` do read frontmatter, which in an encrypted vault
//! means decrypting every Markdown file in scope. Without an identity they
//! list what they can and say what they could not read, rather than
//! failing: the names are the greater part of the answer.

use crate::cli::{ExitCode, GlobalArgs, LsArgs};
use crate::cmd::{find_root, read_document, usage, DocumentRead, Style};
use anyhow::{Context, Result};
use fjord_core::crypto::Identities;
use fjord_core::vault::{self, Content, Vault};
use fjord_core::{doc, manifest};
use std::collections::BTreeMap;
use std::path::Path;

/// One line of output.
#[derive(Debug)]
struct Row {
    /// Repository-relative, as a user would type it.
    path: String,
    kind: Kind,
    id: Option<String>,
    title: Option<String>,
    size: u64,
    modified: Option<std::time::SystemTime>,
    encrypted: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    Vault,
    Directory,
    /// A Markdown file carrying a valid `id`. Spec §8.
    Document,
    /// Everything else: stored, synced and encrypted identically.
    File,
}

impl Kind {
    fn as_str(&self) -> &'static str {
        match self {
            Kind::Vault => "vault",
            Kind::Directory => "directory",
            Kind::Document => "doc",
            Kind::File => "file",
        }
    }
}

pub fn run(args: &LsArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    let scope = match scope(&root, args.path.as_deref()) {
        Ok(scope) => scope,
        Err(message) => return Ok(usage(message)),
    };

    // Only read contents when something will be shown from them.
    let detailed = args.long || global.json;
    let identities = if detailed {
        crate::cmd::load_identities(global).ok()
    } else {
        None
    };

    let vaults = vault::discover(&root).context("could not read the repository's vaults")?;
    let mut rows = Vec::new();
    let mut unreadable = 0usize;

    for vault in &vaults {
        // At the repository root without `-R`, a vault is one line.
        if scope.is_empty() && !args.recursive {
            rows.push(Row {
                path: vault.directory.clone(),
                kind: Kind::Vault,
                id: None,
                title: vault.label().map(String::from),
                size: 0,
                modified: None,
                encrypted: vault.is_encrypted(),
            });
            continue;
        }

        if !scope.is_empty() && !within(&scope, &vault.directory) {
            continue;
        }

        collect(
            &root,
            vault,
            &scope,
            args.recursive,
            detailed,
            identities.as_ref(),
            &mut rows,
            &mut unreadable,
        )?;
    }

    rows.sort_by(|a, b| a.path.cmp(&b.path));

    if global.json {
        println!("{}", render_json(&rows));
        return Ok(ExitCode::Ok);
    }
    render(&rows, args.long, unreadable, global.quiet);
    Ok(ExitCode::Ok)
}

/// The repository-relative directory to list, `""` for the root.
fn scope(root: &Path, requested: Option<&Path>) -> std::result::Result<String, String> {
    let requested = match requested {
        Some(path) => path,
        None => return Ok(String::new()),
    };
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|err| format!("could not resolve {}: {err}", root.display()))?;

    for candidate in [requested.to_path_buf(), canonical_root.join(requested)] {
        if let Ok(absolute) = std::fs::canonicalize(&candidate) {
            return match absolute.strip_prefix(&canonical_root) {
                Ok(relative) => Ok(relative.to_string_lossy().replace('\\', "/")),
                Err(_) => Err(format!("{} is outside the repository", requested.display())),
            };
        }
    }
    Err(format!("{} does not exist", requested.display()))
}

/// Whether `path` is at or below `scope`.
fn within(scope: &str, path: &str) -> bool {
    scope.is_empty()
        || path == scope
        || path.starts_with(&format!("{scope}/"))
        || scope.starts_with(&format!("{path}/"))
}

#[allow(clippy::too_many_arguments)]
fn collect(
    root: &Path,
    vault: &Vault,
    scope: &str,
    recursive: bool,
    detailed: bool,
    identities: Option<&Identities>,
    rows: &mut Vec<Row>,
    unreadable: &mut usize,
) -> Result<()> {
    let contents = vault
        .contents()
        .with_context(|| format!("could not read the {} vault", vault.directory))?;

    // Directories are not entries in their own right, so they are derived
    // from the paths of what they hold.
    let mut directories: BTreeMap<String, (u64, usize)> = BTreeMap::new();

    for content in &contents {
        let repository_path = format!("{}/{}", vault.directory, content.logical);
        if !within(scope, &repository_path) {
            continue;
        }

        let remainder = remainder(scope, &repository_path);
        if !recursive {
            if let Some((directory, _)) = remainder.split_once('/') {
                // Collapse everything below into one directory row.
                let path = if scope.is_empty() {
                    format!("{}/{directory}", vault.directory)
                } else {
                    format!("{scope}/{directory}")
                };
                let entry = directories.entry(path).or_insert((0, 0));
                entry.0 += content.size;
                entry.1 += 1;
                continue;
            }
        }

        let (id, title) = if detailed && content.is_markdown() {
            match frontmatter_of(root, vault, content, identities) {
                Some(frontmatter) => (
                    frontmatter.doc_id().map(String::from),
                    frontmatter.title().map(String::from),
                ),
                None => {
                    *unreadable += 1;
                    (None, None)
                }
            }
        } else {
            (None, None)
        };

        rows.push(Row {
            path: repository_path,
            kind: if id.is_some() {
                Kind::Document
            } else {
                Kind::File
            },
            id,
            title,
            size: content.size,
            modified: content.modified,
            encrypted: content.is_payload,
        });
    }

    for (path, (size, count)) in directories {
        rows.push(Row {
            path,
            kind: Kind::Directory,
            id: None,
            title: Some(crate::cmd::plural(count, "entry", "entries")),
            size,
            modified: None,
            encrypted: vault.is_encrypted(),
        });
    }

    Ok(())
}

/// The part of `path` below `scope`.
fn remainder(scope: &str, path: &str) -> String {
    if scope.is_empty() {
        return path.to_string();
    }
    path.strip_prefix(&format!("{scope}/"))
        .unwrap_or(path)
        .to_string()
}

fn frontmatter_of(
    root: &Path,
    vault: &Vault,
    content: &Content,
    identities: Option<&Identities>,
) -> Option<doc::Frontmatter> {
    let on_disk = root.join(&vault.directory).join(&content.relative);
    let bytes = match read_document(&on_disk, content.is_payload, identities) {
        DocumentRead::Text(bytes) => bytes,
        DocumentRead::NeedsIdentity | DocumentRead::Failed(_) => return None,
    };
    let text = String::from_utf8(bytes.to_vec()).ok()?;
    match doc::parse(&text) {
        doc::Parse::Present { frontmatter, .. } => Some(frontmatter),
        _ => None,
    }
}

fn render(rows: &[Row], long: bool, unreadable: usize, quiet: bool) {
    let style = Style::detect();

    if rows.is_empty() && !quiet {
        println!("  nothing here");
        return;
    }

    let width = rows
        .iter()
        .map(|row| row.path.chars().count())
        .max()
        .unwrap_or(0)
        .min(60);

    for row in rows {
        let marker = match row.kind {
            Kind::Vault => "vault",
            Kind::Directory => "dir",
            Kind::Document => "doc",
            Kind::File => "",
        };

        if !long {
            println!(
                "  {:<width$}  {}",
                row.path,
                style.dim(marker),
                width = width
            );
            continue;
        }

        let detail = match (&row.id, &row.title) {
            (Some(id), Some(title)) => format!("{id}  {title}"),
            (Some(id), None) => id.clone(),
            (None, Some(title)) => title.clone(),
            (None, None) => String::new(),
        };
        println!(
            "  {:<width$}  {:>9}  {:<10}  {}",
            row.path,
            human_size(row.size),
            modified(row.modified),
            style.dim(&detail),
            width = width
        );
    }

    if unreadable > 0 && !quiet {
        println!();
        println!(
            "  {}",
            style.dim(&format!(
                "{} could not be read: no identity of yours decrypts them",
                crate::cmd::plural(unreadable, "document", "documents")
            ))
        );
    }
}

fn human_size(bytes: u64) -> String {
    if bytes == 0 {
        return String::new();
    }
    const UNITS: &[&str] = &["B", "kB", "MB", "GB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

/// Just the date: a listing wants to be scannable, and the time of day is
/// noise in a column.
fn modified(at: Option<std::time::SystemTime>) -> String {
    at.and_then(fjord_core::scalar::rfc3339_utc)
        .map(|timestamp| timestamp.chars().take(10).collect())
        .unwrap_or_default()
}

fn render_json(rows: &[Row]) -> String {
    let entries: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "path": row.path,
                "kind": row.kind.as_str(),
                "id": row.id,
                "title": row.title,
                "size": row.size,
                "encrypted": row.encrypted,
            })
        })
        .collect();
    serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".to_string())
}

/// Keep `manifest` referenced: `Vault::label` reads the field it names.
#[allow(dead_code)]
const _FIELD: &str = manifest::field::NAME;

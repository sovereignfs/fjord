//! Command implementations.
//!
//! Everything here is the binary's business and never `fjord-core`'s:
//! finding the repository, deciding whether to use colour, and rendering a
//! report for a human or for CI.

pub mod verify;

use anyhow::{Context, Result};
use owo_colors::OwoColorize;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

/// Resolve the repository root.
///
/// With `--repo`, the path is taken as given and **not** required to contain
/// a manifest: `fjord verify` must be able to report
/// [`Code::ManifestMissing`][c] against a directory rather than refuse to
/// look at it. Without it, the nearest ancestor holding `fjord.json` wins,
/// falling back to the current directory for the same reason.
///
/// [c]: fjord_core::diagnostics::Code::ManifestMissing
pub fn find_root(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path.to_path_buf());
    }

    let start = std::env::current_dir().context("could not read the current directory")?;
    let mut candidate = start.as_path();
    loop {
        if candidate.join(fjord_core::REPOSITORY_MANIFEST).is_file() {
            return Ok(candidate.to_path_buf());
        }
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => return Ok(start),
        }
    }
}

/// Whether to colour output, and how.
///
/// `NO_COLOR` is honoured, and so is a redirected stdout: a report piped
/// into a file or a CI log should not carry escape codes.
#[derive(Debug, Clone, Copy)]
pub struct Style {
    colour: bool,
}

impl Style {
    pub fn detect() -> Self {
        Self {
            colour: std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal(),
        }
    }

    pub fn error(self, text: &str) -> String {
        if self.colour {
            text.red().to_string()
        } else {
            text.to_string()
        }
    }

    pub fn warning(self, text: &str) -> String {
        if self.colour {
            text.yellow().to_string()
        } else {
            text.to_string()
        }
    }

    pub fn good(self, text: &str) -> String {
        if self.colour {
            text.green().to_string()
        } else {
            text.to_string()
        }
    }

    pub fn dim(self, text: &str) -> String {
        if self.colour {
            text.dimmed().to_string()
        } else {
            text.to_string()
        }
    }
}

/// `1 doc`, `2 docs`.
pub fn plural(count: usize, singular: &str, plural: &str) -> String {
    if count == 1 {
        format!("{count} {singular}")
    } else {
        format!("{count} {plural}")
    }
}

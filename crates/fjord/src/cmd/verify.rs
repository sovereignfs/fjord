// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord verify` — the command the format exists for.
//!
//! Reads a repository, reports coded diagnostics, mutates nothing. Two
//! renderers share one report: a human summary, and `--json` for CI.

use crate::cli::{ExitCode, GlobalArgs, VerifyArgs};
use crate::cmd::{ensure_writable, find_root, plural, Style};
use anyhow::{Context, Result};
use fjord_core::diagnostics::{Diagnostic, Severity};
use fjord_core::manifest::Manifest;
use fjord_core::repair::{self, Repair};
use fjord_core::verify::{self, Options, Report, VaultSummary};
use std::io::Write;

pub fn run(args: &VerifyArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;

    // `--fix` is its own path, run before the read-only one and with an
    // allowlist of exactly what `fjord_core::repair` does. Everything below
    // it is `verify` as it always was, and reports the state after.
    let repairs = if args.fix {
        if let Some(code) = ensure_writable(&root)? {
            return Ok(code);
        }
        Some(apply_repairs(&root)?)
    } else {
        None
    };

    let options = Options {
        vault: args.vault.clone(),
    };

    let report = verify::verify(&root, &options)?;

    let mut out = std::io::stdout().lock();
    if global.json {
        writeln!(out, "{}", render_json(&report, repairs.as_deref()))?;
    } else if !global.quiet {
        let style = Style::detect();
        if let Some(repairs) = &repairs {
            render_repairs(&mut out, repairs, style)?;
        }
        render_human(&mut out, &report, style)?;
        // The files in the clear that `verify` reports are expected while a
        // vault is checked out; say so, once, rather than leave them looking
        // like a mistake.
        for record in crate::cmd::checkout::all(&root)? {
            writeln!(out)?;
            writeln!(
                out,
                "  {}",
                style.dim(&format!(
                    "{0} is checked out, so its decrypted files are expected. \
                     `fjord encrypt {0}` checks it back in.",
                    record.vault
                ))
            )?;
        }
    } else {
        render_quiet(&mut out, &report)?;
    }

    Ok(exit_code(&report, args.strict))
}

/// Repair `fjord.json` where it disagrees with the disk, and write it.
///
/// Written through a temporary file in the same directory, so an
/// interrupted write cannot leave a truncated manifest. Nothing is
/// committed: what changed is in the output, and `git diff` shows it.
fn apply_repairs(root: &std::path::Path) -> Result<Vec<Repair>> {
    let path = root.join(fjord_core::REPOSITORY_MANIFEST);
    let manifest = match std::fs::read(&path)
        .ok()
        .and_then(|bytes| Manifest::parse(&bytes).ok())
    {
        Some(manifest) => manifest,
        // An unreadable manifest is a finding for the report below, not
        // something to guess a repair for.
        None => return Ok(Vec::new()),
    };

    let everything = verify::verify(root, &Options::default())?;
    let Some(plan) = repair::plan_manifest(root, &manifest, &everything) else {
        return Ok(Vec::new());
    };

    let mut temporary = tempfile::Builder::new()
        .prefix(".fjord-fix-")
        .suffix(".tmp")
        .tempfile_in(root)
        .context("could not stage fjord.json")?;
    temporary
        .write_all(plan.text.as_bytes())
        .context("could not write fjord.json")?;
    temporary
        .as_file()
        .sync_all()
        .context("could not flush fjord.json")?;
    temporary
        .persist(&path)
        .context("could not replace fjord.json")?;

    Ok(plan.repairs)
}

fn render_repairs(out: &mut impl Write, repairs: &[Repair], style: Style) -> Result<()> {
    if repairs.is_empty() {
        writeln!(out, "  {}", style.dim("nothing to repair"))?;
    } else {
        for repair in repairs {
            let (verb, preposition) = match repair {
                Repair::Added { .. } => ("added", "to"),
                Repair::Removed { .. } => ("removed", "from"),
            };
            writeln!(
                out,
                "  {} {} {preposition} {}",
                style.good(verb),
                repair.path(),
                fjord_core::REPOSITORY_MANIFEST
            )?;
        }
        writeln!(
            out,
            "  {}",
            style.dim("not committed; `git diff fjord.json` shows the change")
        )?;
    }
    writeln!(out)?;
    Ok(())
}

fn exit_code(report: &Report, strict: bool) -> ExitCode {
    if report.errors() > 0 || (strict && report.warnings() > 0) {
        ExitCode::Problems
    } else {
        ExitCode::Ok
    }
}

// --- Human ---------------------------------------------------------------

/// Width the status column is padded to, so vault names line up under
/// `fjord.json`.
const LABEL_WIDTH: usize = 20;

fn render_human(out: &mut impl Write, report: &Report, style: Style) -> Result<()> {
    let repository = tally(report, None);

    writeln!(
        out,
        "  {} {:<width$}{}",
        mark(repository, style),
        fjord_core::REPOSITORY_MANIFEST,
        style.dim(&repository_headline(report, repository)),
        width = LABEL_WIDTH
    )?;

    for (index, vault) in report.vaults.iter().enumerate() {
        let counts = tally(report, Some(index));
        writeln!(
            out,
            "  {} {:<width$}{}",
            mark(counts, style),
            vault.path,
            style.dim(&match counts.headline() {
                Some(headline) => headline,
                None => vault_headline(vault),
            }),
            width = LABEL_WIDTH
        )?;
    }

    if !report.diagnostics.is_empty() {
        writeln!(out)?;
        render_findings(out, report, style)?;
    }

    writeln!(out)?;
    writeln!(
        out,
        "  {}, {}",
        plural(report.errors(), "error", "errors"),
        plural(report.warnings(), "warning", "warnings")
    )?;

    if report.read_only {
        writeln!(out)?;
        writeln!(
            out,
            "  {} this repository was made by a newer version of Fjord.",
            style.warning("read-only:")
        )?;
        writeln!(
            out,
            "  Reading it is fine; this build must not write to it."
        )?;
    }

    Ok(())
}

/// Errors and warnings attributable to one vault, or to the repository
/// itself when `vault` is `None`.
#[derive(Debug, Clone, Copy)]
struct Tally {
    errors: usize,
    warnings: usize,
}

impl Tally {
    /// What to print instead of the usual summary, when there is something
    /// to report.
    ///
    /// Warnings are named as warnings rather than lumped in as "problems":
    /// a repository with only warnings conforms and exits 0, so calling
    /// them problems contradicts the verdict three lines further down.
    fn headline(self) -> Option<String> {
        if self.errors > 0 {
            Some(plural(self.errors + self.warnings, "problem", "problems"))
        } else if self.warnings > 0 {
            Some(plural(self.warnings, "warning", "warnings"))
        } else {
            None
        }
    }
}

fn tally(report: &Report, vault: Option<usize>) -> Tally {
    let mut counts = Tally {
        errors: 0,
        warnings: 0,
    };
    for diagnostic in &report.diagnostics {
        if vault_of(diagnostic, &report.vaults) != vault {
            continue;
        }
        match diagnostic.severity() {
            Severity::Error => counts.errors += 1,
            Severity::Warning => counts.warnings += 1,
        }
    }
    counts
}

fn repository_headline(report: &Report, counts: Tally) -> String {
    if let Some(headline) = counts.headline() {
        return headline;
    }
    match report.version {
        Some(version) => format!("format version {version}"),
        None => "no format version declared".to_string(),
    }
}

fn vault_headline(vault: &VaultSummary) -> String {
    let mut parts = Vec::new();
    if vault.encrypted {
        // No doc count: `verify` never decrypts, so it cannot tell a Doc
        // from any other file in here. Printing "0 docs" would read as a
        // fact about the vault rather than about what was inspected.
        parts.push("encrypted".to_string());
        parts.push(plural(vault.recipients, "recipient", "recipients"));
        parts.push(plural(vault.files, "file", "files"));
    } else {
        parts.push("plaintext".to_string());
        parts.push(plural(vault.docs, "doc", "docs"));
        parts.push(plural(vault.files, "file", "files"));
    }
    parts.join(" · ")
}

/// `✓` conforming, `⚠` warnings only, `✗` at least one error.
///
/// The three-way distinction matters: `✗` beside a line that exits 0 reads
/// as a failure that did not happen.
fn mark(counts: Tally, style: Style) -> String {
    if counts.errors > 0 {
        style.error("✗")
    } else if counts.warnings > 0 {
        style.warning("⚠")
    } else {
        style.good("✓")
    }
}

/// Every diagnostic, grouped by the path it concerns.
///
/// Rendered from the full list rather than per vault, so that a finding
/// belonging to no vault — or to a vault whose manifest could not be read —
/// can never be silently dropped from the output.
fn render_findings(out: &mut impl Write, report: &Report, style: Style) -> Result<()> {
    let mut current: Option<&str> = None;
    for diagnostic in &report.diagnostics {
        let path = diagnostic.path.as_deref().unwrap_or(".");
        if current != Some(path) {
            writeln!(out, "    {path}")?;
            current = Some(path);
        }

        let code = match diagnostic.severity() {
            Severity::Error => style.error(diagnostic.code.as_str()),
            Severity::Warning => style.warning(diagnostic.code.as_str()),
        };
        writeln!(out, "      {code}  {}", diagnostic.code.message())?;
        if let Some(detail) = &diagnostic.detail {
            writeln!(out, "            {}", style.dim(detail))?;
        }
    }
    Ok(())
}

/// `--quiet`: errors still print, one per line, nothing else.
fn render_quiet(out: &mut impl Write, report: &Report) -> Result<()> {
    for diagnostic in &report.diagnostics {
        if diagnostic.severity() != Severity::Error {
            continue;
        }
        let path = diagnostic.path.as_deref().unwrap_or(".");
        writeln!(
            out,
            "{}: {}: {}",
            path,
            diagnostic.code.as_str(),
            diagnostic.code.message()
        )?;
    }
    Ok(())
}

/// Which vault a diagnostic belongs to, if any.
fn vault_of(diagnostic: &Diagnostic, vaults: &[VaultSummary]) -> Option<usize> {
    let path = diagnostic.path.as_deref()?;
    vaults
        .iter()
        .position(|vault| path == vault.path || path.starts_with(&format!("{}/", vault.path)))
}

// --- JSON ----------------------------------------------------------------

/// Machine-readable output. The shape is published API: see
/// `schema/verify.schema.json`, which `crates/fjord/tests/cli.rs` checks
/// this against.
fn render_json(report: &Report, repairs: Option<&[Repair]>) -> String {
    let diagnostics: Vec<serde_json::Value> = report
        .diagnostics
        .iter()
        .map(|diagnostic| {
            serde_json::json!({
                "code": diagnostic.code.as_str(),
                "severity": diagnostic.severity().to_string(),
                "path": diagnostic.path,
                "message": diagnostic.code.message(),
                "detail": diagnostic.detail,
            })
        })
        .collect();

    let vaults: Vec<serde_json::Value> = report
        .vaults
        .iter()
        .map(|vault| {
            serde_json::json!({
                "path": vault.path,
                "name": vault.name,
                "encrypted": vault.encrypted,
                "fileNaming": vault.file_naming,
                "recipients": vault.recipients,
                "docs": vault.docs,
                "files": vault.files,
            })
        })
        .collect();

    let mut document = serde_json::json!({
        "tool": concat!("fjord ", env!("CARGO_PKG_VERSION")),
        "conformance": fjord_core::conformance::DECLARED
            .iter()
            .map(|level| level.as_str())
            .collect::<Vec<_>>(),
        "formatVersion": report.version,
        "conforms": report.conforms(),
        "readOnly": report.read_only,
        "counts": {
            "errors": report.errors(),
            "warnings": report.warnings(),
        },
        "vaults": vaults,
        "diagnostics": diagnostics,
    });

    // Present only when `--fix` was asked for, so its absence means no
    // repair was attempted rather than none was needed.
    if let (Some(repairs), Some(map)) = (repairs, document.as_object_mut()) {
        map.insert(
            "repairs".to_string(),
            repairs
                .iter()
                .map(|repair| {
                    serde_json::json!({ "action": repair.action(), "path": repair.path() })
                })
                .collect(),
        );
    }

    serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string())
}

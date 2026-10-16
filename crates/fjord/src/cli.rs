//! The command surface.
//!
//! This file fixes the CLI's shape: every command, flag and default is
//! declared here and nowhere else. Implementations live in `cmd/`.
//!
//! Two rules bind every command:
//!
//! - **Interactive on a TTY, scriptable otherwise.** Check
//!   [`std::io::IsTerminal`]. With `--no-input`, a prompt is a usage error
//!   (exit 2), never a hang. Something running in CI must fail fast.
//! - **No secret in `argv`.** Identities arrive as a path or on stdin.
//!   `argv` is readable by every process on the machine and lands in shell
//!   history.

use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "fjord",
    version,
    about = "Keep your documents in a Git repository you control.",
    long_about = None,
    disable_help_subcommand = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,

    #[command(flatten)]
    pub global: GlobalArgs,
}

#[derive(Debug, Args)]
pub struct GlobalArgs {
    /// Repository root. Defaults to the nearest ancestor containing fjord.json.
    #[arg(long, short = 'C', global = true, value_name = "PATH")]
    pub repo: Option<PathBuf>,

    /// Path to the age identity file. Never pass a key itself as an argument.
    #[arg(long, global = true, env = "FJORD_IDENTITY", value_name = "PATH")]
    pub identity: Option<PathBuf>,

    /// Never prompt. A required prompt becomes a usage error.
    #[arg(long, global = true)]
    pub no_input: bool,

    /// Machine-readable output, where the command supports it.
    #[arg(long, global = true)]
    pub json: bool,

    /// Suppress informational output. Errors still print.
    #[arg(long, short, global = true)]
    pub quiet: bool,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a conforming repository.
    Init(InitArgs),

    /// Check the repository against the specification. Mutates nothing.
    Verify(VerifyArgs),

    /// Decrypt a document, open $EDITOR, re-encrypt on change.
    Open(OpenArgs),

    /// Encrypt a file in place, inside an encrypted vault.
    Encrypt(EncryptArgs),

    /// Decrypt a file to stdout.
    Decrypt(DecryptArgs),

    /// Create a Fjord Doc with valid frontmatter.
    New(NewArgs),

    /// List Docs and vault files.
    Ls(LsArgs),

    /// Search document contents.
    Grep(GrepArgs),

    /// Repository health and sync state.
    Status,

    /// Pull, resolve conflicts, push.
    Sync(SyncArgs),

    /// Manage age identities and recipients.
    #[command(subcommand)]
    Key(KeyCommand),

    /// Re-encrypt a vault to its current recipient list.
    Rekey(RekeyArgs),

    /// Decrypt a vault into a plain directory.
    Export(ExportArgs),

    /// Bring a directory of files into a vault as Docs.
    Import(ImportArgs),

    /// Manage vaults.
    #[command(subcommand)]
    Vault(VaultCommand),
}

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Directory to create. Defaults to the current directory.
    pub path: Option<PathBuf>,

    /// Repository display name. Defaults to the directory name.
    #[arg(long)]
    pub name: Option<String>,

    /// Create the Private vault unencrypted.
    #[arg(long)]
    pub no_encrypt: bool,

    /// Skip `git init` and the first commit.
    #[arg(long)]
    pub no_git: bool,
}

#[derive(Debug, Args)]
pub struct VerifyArgs {
    /// Check one vault only.
    #[arg(long, value_name = "NAME")]
    pub vault: Option<String>,

    /// Apply safe repairs. Never touches document content, never moves a
    /// file, never resolves a case collision or a duplicate id.
    #[arg(long)]
    pub fix: bool,

    /// Treat warnings as errors.
    #[arg(long)]
    pub strict: bool,
}

#[derive(Debug, Args)]
pub struct OpenArgs {
    /// Document to edit, relative to the repository root.
    pub path: PathBuf,

    /// Editor command. Overrides $VISUAL and $EDITOR.
    #[arg(long, value_name = "CMD")]
    pub editor: Option<String>,

    /// Commit after a successful edit.
    #[arg(long)]
    pub commit: bool,
}

#[derive(Debug, Args)]
pub struct EncryptArgs {
    /// File to encrypt. Must be inside an encrypted vault.
    pub path: PathBuf,

    /// Keep the plaintext after encrypting.
    ///
    /// Leaves the file in the clear inside an encrypted vault, which
    /// `fjord verify` reports as E201. Only useful while checking what
    /// happened.
    #[arg(long)]
    pub keep: bool,
}

#[derive(Debug, Args)]
pub struct DecryptArgs {
    /// Encrypted file to read.
    pub path: PathBuf,

    /// Write the plaintext here instead of to stdout.
    ///
    /// Refused if it would land inside an encrypted vault: decrypted
    /// content must never be written into one.
    #[arg(long, short, value_name = "PATH")]
    pub out: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct NewArgs {
    /// Path for the new document, relative to the repository root.
    pub path: PathBuf,

    /// Title. Defaults to the file stem.
    #[arg(long)]
    pub title: Option<String>,

    /// Create the file without opening an editor.
    #[arg(long)]
    pub no_edit: bool,
}

#[derive(Debug, Args)]
pub struct LsArgs {
    /// Directory to list. Defaults to the repository root.
    pub path: Option<PathBuf>,

    /// Show id, size and modification time.
    #[arg(long, short)]
    pub long: bool,

    /// Recurse into subdirectories.
    #[arg(long, short = 'R')]
    pub recursive: bool,
}

#[derive(Debug, Args)]
pub struct GrepArgs {
    /// Pattern to search for.
    pub pattern: String,

    /// Restrict the search to this path.
    pub path: Option<PathBuf>,

    /// Case-insensitive.
    #[arg(long, short)]
    pub ignore_case: bool,
}

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// Pull and merge without pushing.
    #[arg(long)]
    pub no_push: bool,

    /// Commit message for local changes.
    #[arg(long, short, value_name = "TEXT")]
    pub message: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum KeyCommand {
    /// Generate an identity. Written outside the repository, shown once.
    New {
        /// Where to write it. Defaults to $FJORD_CONFIG_DIR/identity.txt.
        #[arg(long, value_name = "PATH")]
        out: Option<PathBuf>,
    },

    /// Add a recipient to a vault.
    ///
    /// This does not grant access to files written earlier: age encrypts to
    /// the recipients present at write time. Run `fjord rekey` afterwards if
    /// the new key must read existing documents.
    Add {
        /// age recipient, e.g. age1… or an ssh-ed25519 public key.
        recipient: String,

        #[arg(long, value_name = "NAME")]
        vault: String,
    },

    /// List a vault's recipients.
    List {
        #[arg(long, value_name = "NAME")]
        vault: Option<String>,
    },

    /// Remove a recipient from a vault.
    ///
    /// This revokes nothing. Every version already committed stays readable
    /// by that key, permanently. The command says so before acting.
    Remove {
        recipient: String,

        #[arg(long, value_name = "NAME")]
        vault: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum VaultCommand {
    /// Create a vault.
    Add {
        name: String,

        /// Encrypt it with age.
        #[arg(long)]
        encrypted: bool,

        /// Name files by ULID instead of by title. Requires --encrypted.
        #[arg(long)]
        id_naming: bool,
    },

    /// List vaults.
    List,
}

#[derive(Debug, Args)]
pub struct RekeyArgs {
    /// Vault to re-encrypt.
    pub vault: String,

    /// Skip the confirmation prompt. Rewrites the whole vault in one commit.
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct ExportArgs {
    pub vault: String,
    pub dir: PathBuf,
}

#[derive(Debug, Args)]
pub struct ImportArgs {
    pub dir: PathBuf,
    pub vault: String,
}

/// Process exit codes. See README § Exit codes.
#[derive(Debug, Clone, Copy)]
#[repr(i32)]
pub enum ExitCode {
    /// Success, or the repository conforms.
    Ok = 0,
    /// Problems found — a non-conforming repository, or an unresolved merge.
    Problems = 1,
    /// Usage error, including a prompt required under `--no-input`.
    Usage = 2,
    /// IO or git failure.
    Io = 3,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// Catches conflicting flags and malformed help text at test time rather
    /// than at a user's first invocation.
    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn identity_is_never_a_positional_secret() {
        // A key must arrive by path or stdin, never in argv. If this ever
        // parses, someone has added a flag that takes key material directly.
        let parsed = Cli::try_parse_from(["fjord", "verify", "--identity", "/tmp/id.txt"]);
        assert!(parsed.is_ok());
        assert!(Cli::try_parse_from(["fjord", "verify", "--key", "AGE-SECRET-KEY-1"]).is_err());
    }
}

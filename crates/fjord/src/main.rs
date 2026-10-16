//! `fjord` — reference toolchain for the Fjord repository format.
//!
//! This binary owns everything `fjord-core` refuses to: argument parsing,
//! prompting, colour, the editor round trip, and git. See `CLAUDE.md`.

mod cli;
mod cmd;

use clap::Parser;
use cli::{Cli, Command, ExitCode};
use std::process::ExitCode as ProcessExitCode;

fn main() -> ProcessExitCode {
    let args = Cli::parse();

    match run(args) {
        Ok(code) => ProcessExitCode::from(code as u8),
        Err(err) => {
            // Print the context chain, outermost first.
            eprintln!("error: {err}");
            for cause in err.chain().skip(1) {
                eprintln!("  caused by: {cause}");
            }
            ProcessExitCode::from(ExitCode::Io as u8)
        }
    }
}

fn run(args: Cli) -> anyhow::Result<ExitCode> {
    // Implement in milestone order; see CLAUDE.md § Milestones.
    match &args.command {
        Command::Verify(verify) => cmd::verify::run(verify, &args.global),
        Command::Init(_) => todo!("M2: scaffold a conforming repository, git init, first commit"),
        Command::Key(_) => todo!("M3: age identities and recipients"),
        Command::Open(_) => todo!("M4: decrypt, $EDITOR, re-encrypt on change, shred"),
        Command::New(_) | Command::Ls(_) | Command::Grep(_) | Command::Status => {
            todo!("M5: everyday commands")
        }
        Command::Sync(_) => todo!("M6: pull, decrypt-merge-reencrypt, push"),
        Command::Rekey(_) | Command::Export(_) | Command::Import(_) | Command::Vault(_) => {
            todo!("M3/M5: vault and key maintenance")
        }
    }
}

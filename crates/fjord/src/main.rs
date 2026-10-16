//! `fjord` — reference toolchain for the Fjord repository format.
//!
//! This binary owns everything `fjord-core` refuses to: argument parsing,
//! prompting, colour, the editor round trip, and git. See `CLAUDE.md`.

mod cli;
mod cmd;
mod git;

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
        Command::Init(init) => cmd::init::run(init, &args.global),
        Command::Key(key) => cmd::keys::run(key, &args.global),
        Command::Encrypt(encrypt) => cmd::crypt::encrypt(encrypt, &args.global),
        Command::Decrypt(decrypt) => cmd::crypt::decrypt(decrypt, &args.global),
        Command::Open(open) => cmd::open::run(open, &args.global),
        Command::New(new) => cmd::new::run(new, &args.global),
        Command::Ls(ls) => cmd::list::run(ls, &args.global),
        Command::Grep(grep) => cmd::grep::run(grep, &args.global),
        Command::Status => cmd::status::run(&args.global),
        Command::Sync(sync) => cmd::sync::run(sync, &args.global),
        Command::Rekey(_) | Command::Export(_) | Command::Import(_) | Command::Vault(_) => {
            todo!("M3/M5: vault and key maintenance")
        }
    }
}

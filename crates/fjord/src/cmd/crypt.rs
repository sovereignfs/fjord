//! `fjord encrypt` and `fjord decrypt`. Spec §6.
//!
//! The two commands are deliberately asymmetric, and invariant 1 is why.
//!
//! `encrypt` writes the payload beside the plaintext and then removes the
//! plaintext — it is the repair for a file that should never have been in
//! the clear inside an encrypted vault.
//!
//! `decrypt` writes to **stdout** by default, and refuses `--out` into an
//! encrypted vault. There is no invocation of either command that leaves
//! plaintext inside one.

use crate::cli::{DecryptArgs, EncryptArgs, ExitCode, GlobalArgs};
use crate::cmd::{find_root, load_identities, repo_relative, resolve_destination, usage, Style};
use anyhow::{Context, Result};
use fjord_core::vault::{self, Vault};
use fjord_core::{crypto, store};
use std::io::Write;
use std::path::Path;

pub fn encrypt(args: &EncryptArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    let relative = match repo_relative(&root, &args.path)? {
        Ok(relative) => relative,
        Err(message) => return Ok(usage(message)),
    };

    let vault = match encrypted_vault(&root, &relative)? {
        Ok(vault) => vault,
        Err(code) => return Ok(code),
    };

    let suffix = vault.suffix();
    if relative.ends_with(&suffix) {
        return Ok(usage(format!("{relative} is already an encrypted payload")));
    }

    let destination = root.join(format!("{relative}{suffix}"));
    if destination.exists() {
        return Ok(usage(format!(
            "{relative}{suffix} already exists. Encrypting over it would make the \
             existing payload unrecoverable"
        )));
    }

    let recipients = crypto::parse_recipients(
        &vault
            .read_recipients()
            .context("could not read the recipients file")?,
    )
    .with_context(|| {
        format!(
            "the {} vault's recipients file is not usable",
            vault.directory
        )
    })?;

    if recipients.is_empty() {
        // §6.2: refuse rather than store plaintext.
        return Ok(usage(format!(
            "the {} vault has no recipients, so nothing can be encrypted to it. \
             Add one with `fjord key add`",
            vault.directory
        )));
    }

    let source = root.join(&relative);
    let plaintext = zeroize::Zeroizing::new(
        std::fs::read(&source).with_context(|| format!("could not read {relative}"))?,
    );
    let leaf = relative.rsplit('/').next().unwrap_or(&relative).to_string();
    let ciphertext = store::store(&vault, &leaf, &plaintext, Some(&recipients))
        .with_context(|| format!("could not encrypt {relative}"))?;
    std::fs::write(&destination, &ciphertext)
        .with_context(|| format!("could not write {relative}{suffix}"))?;

    // Read it back before removing the only plaintext copy. The header
    // parse costs nothing; the full round trip needs an identity, so it
    // happens when one is available and is reported when it is not.
    let written = std::fs::read(&destination)
        .with_context(|| format!("could not re-read {relative}{suffix}"))?;
    if !crypto::is_well_formed(&written) {
        let _ = std::fs::remove_file(&destination);
        anyhow::bail!(
            "the payload written for {relative} is not a well-formed age file; \
             the plaintext has been left untouched"
        );
    }

    let verified = match load_identities(global) {
        Ok(identities) => match store::load(&vault, &written, Some(&identities)) {
            Ok(recovered) => {
                let recovered = recovered.plaintext;
                // A direct comparison, not a hash: the buffers are both in
                // hand, so there is nothing a digest would add but a way to
                // be wrong.
                if recovered[..] != plaintext[..] {
                    let _ = std::fs::remove_file(&destination);
                    anyhow::bail!(
                        "the payload written for {relative} did not decrypt to the \
                         original bytes; the plaintext has been left untouched"
                    );
                }
                true
            }
            // Not an error: the identity simply is not among this vault's
            // recipients, which is normal on a shared vault.
            Err(_) => false,
        },
        Err(_) => false,
    };

    if !args.keep {
        std::fs::remove_file(&source)
            .with_context(|| format!("could not remove the plaintext {relative}"))?;
    }

    if !global.quiet {
        let style = Style::detect();
        println!(
            "  {} {relative}{suffix}  {}",
            style.good("encrypted"),
            style.dim(&format!(
                "to {} {}",
                recipients.len(),
                if recipients.len() == 1 {
                    "recipient"
                } else {
                    "recipients"
                }
            ))
        );
        if args.keep {
            println!();
            println!(
                "  {}",
                style.warning(&format!(
                    "{relative} is still in the clear inside an encrypted vault (E201)."
                ))
            );
        } else {
            println!("  {} {relative}", style.dim("removed"));
        }
        if !verified {
            println!();
            println!(
                "  {}",
                style.dim(
                    "Checked the payload's header only: no identity of yours is among \
                     this vault's recipients, so the round trip could not be confirmed."
                )
            );
        }
    }

    Ok(ExitCode::Ok)
}

pub fn decrypt(args: &DecryptArgs, global: &GlobalArgs) -> Result<ExitCode> {
    let root = find_root(global.repo.as_deref())?;
    let relative = match repo_relative(&root, &args.path)? {
        Ok(relative) => relative,
        Err(message) => return Ok(usage(message)),
    };

    let vault = match encrypted_vault(&root, &relative)? {
        Ok(vault) => vault,
        Err(code) => return Ok(code),
    };

    let suffix = vault.suffix();
    if !relative.ends_with(&suffix) {
        return Ok(usage(format!(
            "{relative} is not an encrypted payload (it does not end in {suffix})"
        )));
    }

    // Invariant 1: there is no `--out` that writes plaintext into an
    // encrypted vault.
    if let Some(out) = &args.out {
        if let Some(problem) = destination_inside_encrypted_vault(&root, out)? {
            return Ok(usage(problem));
        }
    }

    let identities = load_identities(global)?;
    let ciphertext = std::fs::read(root.join(&relative))
        .with_context(|| format!("could not read {relative}"))?;
    let plaintext = store::load(&vault, &ciphertext, Some(&identities))
        .with_context(|| format!("could not decrypt {relative}"))?
        .plaintext;

    match &args.out {
        Some(out) => {
            std::fs::write(out, &plaintext[..])
                .with_context(|| format!("could not write {}", out.display()))?;
            if !global.quiet {
                let style = Style::detect();
                println!("  {} {}", style.good("decrypted"), out.display());
            }
        }
        None => {
            // Binary-safe, and never a trailing newline of our own: the
            // bytes are the file's.
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            stdout
                .write_all(&plaintext[..])
                .context("could not write the plaintext to stdout")?;
            stdout.flush().context("could not flush stdout")?;
        }
    }

    Ok(ExitCode::Ok)
}

/// The encrypted vault containing `relative`, or the usage error saying why
/// there is none.
fn encrypted_vault(root: &Path, relative: &str) -> Result<std::result::Result<Vault, ExitCode>> {
    let found =
        vault::containing(root, relative).context("could not read the repository's vaults")?;
    let vault = match found {
        Some(vault) => vault,
        None => return Ok(Err(usage(format!("{relative} is not inside a vault")))),
    };
    if !vault.is_encrypted() {
        return Ok(Err(usage(format!(
            "the {} vault is not encrypted",
            vault.directory
        ))));
    }
    Ok(Ok(vault))
}

/// Why writing plaintext to `out` would be wrong, if it would be.
fn destination_inside_encrypted_vault(root: &Path, out: &Path) -> Result<Option<String>> {
    // Resolved through symlinked ancestors: comparing an unresolved path
    // against a canonical root would let a destination inside the vault
    // look as though it were outside the repository.
    let absolute = resolve_destination(out);
    let canonical_root = std::fs::canonicalize(root)
        .with_context(|| format!("could not resolve {}", root.display()))?;
    let inside = match absolute.strip_prefix(&canonical_root) {
        Ok(inside) => inside,
        // Outside the repository entirely, which is the recommended place
        // for decrypted content.
        Err(_) => return Ok(None),
    };

    let relative = inside.to_string_lossy().replace('\\', "/");
    let vault = vault::containing(&canonical_root, &relative)
        .context("could not read the repository's vaults")?;
    match vault {
        Some(vault) if vault.is_encrypted() => Ok(Some(format!(
            "{} is inside the encrypted {} vault. Decrypted content must never be \
             written into one (spec §6.5) — write it outside the repository, or let it \
             go to stdout",
            out.display(),
            vault.directory
        ))),
        _ => Ok(None),
    }
}

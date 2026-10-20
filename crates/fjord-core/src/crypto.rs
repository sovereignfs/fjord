// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! age encryption. Spec §6.1.
//!
//! The payload format is `age-encryption.org/v1`, **unmodified**, produced
//! by the `age` crate. No Fjord-specific cryptography is defined here and
//! none may be added: the guarantee that `age -d` alone recovers a file is
//! load-bearing, and anything that broke it would make the format a
//! liability rather than a container. The test that matters most in this
//! repository is the one proving this module and the `age` binary agree.
//!
//! # What this build does not support
//!
//! **SSH recipients.** §6.2 permits them and `fjord verify` accepts them,
//! so a repository using them conforms and this crate says so. But writing
//! to one means linking `rsa`, which carries RUSTSEC-2023-0071 — a
//! key-recovery timing side-channel with no fixed version available — and
//! §6.2 makes SSH recipients optional while X25519 is mandatory. An
//! optional recipient type is not worth an unfixable weakness in an
//! encryption tool, so [`parse_recipients`] refuses one by name and says
//! why.
//!
//! # Secret hygiene
//!
//! Spec §11.3 says clients SHOULD zeroise key material and decrypted
//! plaintext. Decryption therefore returns [`Zeroizing<Vec<u8>>`], and a
//! generated identity's secret is held in a [`Zeroizing<String>`], so both
//! are wiped when dropped rather than left in freed memory. Nothing here
//! takes a secret as a `&str` that a caller might have logged first.

use crate::manifest::{self, RecipientKind};
use std::io::{Read, Write};
use zeroize::Zeroizing;

/// Why a cryptographic operation could not be completed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A recipients file line is not a recipient this build can encrypt to.
    #[error("line {line}: {reason}")]
    Recipient { line: usize, reason: String },
    /// A vault has no recipients, so nothing can be written to it. Spec
    /// §6.2 requires a client to refuse rather than store plaintext.
    #[error("the vault has no recipients, so nothing can be encrypted to it")]
    NoRecipients,
    /// The identity file holds nothing usable.
    #[error("no usable identity was found")]
    NoIdentities,
    /// An identity file could not be read or parsed.
    #[error("could not read the identity: {0}")]
    Identity(String),
    #[error("could not encrypt: {0}")]
    Encrypt(String),
    /// Decryption failed. Most often the wrong identity, which is
    /// indistinguishable from a corrupt payload by design.
    #[error("could not decrypt: {0}")]
    Decrypt(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// Why an SSH recipient is refused. One text, because it is said in three
/// places and they must agree.
const SSH_UNSUPPORTED: &str = "SSH recipients are not supported by this build, which links \
    no RSA implementation on purpose (RUSTSEC-2023-0071). A vault using them is still \
    conforming; use `age1…` recipients instead, and `fjord rekey` an existing vault to them";

/// Whether `text` is a secret key, which must never be echoed.
fn is_secret_key(text: &str) -> bool {
    text.trim()
        .to_ascii_uppercase()
        .starts_with("AGE-SECRET-KEY-")
}

/// `text` as it is safe to show in a message.
///
/// A secret key pasted where a public one was expected is a real mistake,
/// and an error message that repeats its argument would print it — into a
/// terminal's scrollback and into whatever log captured the command.
pub fn display_safe(text: &str) -> String {
    if is_secret_key(text) {
        "(a secret key, not shown)".to_string()
    } else {
        text.trim().to_string()
    }
}

/// Whether `text` can be the recipient of a vault, and if not, why. Spec
/// §6.2.
///
/// For a caller holding a single recipient — `key add`, `vault add
/// --recipient` — as opposed to a whole file, which [`parse_recipients`]
/// reads. The reasons are written to follow the value in a message:
/// `"<key>: <reason>"`.
pub fn check_recipient(text: &str) -> Result<(), String> {
    use manifest::{classify_recipient, RecipientKind};

    if is_secret_key(text) {
        return Err(
            "that is a secret key, and this takes a public one. A secret key must never be \
             passed as an argument — it is now in your shell history, so treat it as exposed. \
             The public key is the `age1…` line: `fjord key list`, or `age-keygen -y <file>`"
                .to_string(),
        );
    }

    match classify_recipient(text) {
        Some(RecipientKind::X25519) => Ok(()),
        Some(RecipientKind::Ssh) => Err(SSH_UNSUPPORTED.to_string()),
        Some(RecipientKind::Passphrase) => Err(
            "a passphrase recipient is not permitted in a vault (spec §6.2): age refuses to \
             combine one with any other recipient, and a passphrase-encrypted vault is a \
             different threat model"
                .to_string(),
        ),
        Some(RecipientKind::Malformed) if text.trim().starts_with("age1") => Err(
            "looks like an age public key but does not check out — a character is probably \
             mistyped or missing"
                .to_string(),
        ),
        Some(RecipientKind::Malformed) => {
            Err("not an age recipient; expected an `age1…` public key".to_string())
        }
        None => Err("not a recipient: it is empty or a comment".to_string()),
    }
}

/// Recipients a payload will be encrypted to.
///
/// Every file is encrypted to **all** of them, so any one identity can read
/// it. Spec §6.2.
pub struct Recipients {
    parsed: Vec<Box<dyn age::Recipient + Send>>,
    /// The textual form of each, in file order, for display.
    text: Vec<String>,
}

impl std::fmt::Debug for Recipients {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `dyn Recipient` is not Debug, and the public keys are the useful
        // part anyway.
        f.debug_struct("Recipients")
            .field("recipients", &self.text)
            .finish()
    }
}

impl Recipients {
    pub fn len(&self) -> usize {
        self.parsed.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parsed.is_empty()
    }

    /// The recipients as written, in file order.
    pub fn text(&self) -> &[String] {
        &self.text
    }
}

/// Parse a recipients file. Spec §6.2.
///
/// Line classification is delegated to [`manifest::parse_recipients`], so
/// that what `fjord verify` calls a valid recipients file and what this will
/// encrypt to cannot drift apart.
pub fn parse_recipients(text: &str) -> Result<Recipients, Error> {
    let mut parsed: Vec<Box<dyn age::Recipient + Send>> = Vec::new();
    let mut display = Vec::new();

    for line in manifest::parse_recipients(text) {
        match line.kind {
            RecipientKind::X25519 => match line.text.parse::<age::x25519::Recipient>() {
                Ok(recipient) => parsed.push(Box::new(recipient)),
                Err(reason) => {
                    return Err(Error::Recipient {
                        line: line.number,
                        reason: reason.to_string(),
                    })
                }
            },
            // §6.2 permits SSH recipients ("MAY"), and `fjord verify`
            // accepts them: a repository using them conforms, and saying
            // otherwise would be wrong. This build simply cannot write to
            // them, because support means linking `rsa`, which carries an
            // unfixed key-recovery timing side-channel (RUSTSEC-2023-0071).
            // Refusing loudly is better than either shipping that or
            // pretending the vault is writable.
            RecipientKind::Ssh => {
                return Err(Error::Recipient {
                    line: line.number,
                    reason: SSH_UNSUPPORTED.to_string(),
                })
            }
            RecipientKind::Passphrase => {
                return Err(Error::Recipient {
                    line: line.number,
                    reason: "a passphrase recipient is not permitted in a vault (§6.2)".to_string(),
                })
            }
            RecipientKind::Malformed => {
                return Err(Error::Recipient {
                    line: line.number,
                    reason: "not a recognised age recipient".to_string(),
                })
            }
        }
        display.push(line.text);
    }

    Ok(Recipients {
        parsed,
        text: display,
    })
}

/// Identities that may decrypt a payload.
pub struct Identities {
    // `Send + Sync` since age 0.12, which is what `IdentityFile` now hands
    // back. No loss: an identity that can cross a thread boundary is
    // strictly more useful, and the clients will want it.
    parsed: Vec<Box<dyn age::Identity + Send + Sync>>,
}

impl std::fmt::Debug for Identities {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately opaque: an identity must never reach a log through a
        // derived Debug.
        f.debug_struct("Identities")
            .field("count", &self.parsed.len())
            .finish()
    }
}

impl Identities {
    pub fn len(&self) -> usize {
        self.parsed.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parsed.is_empty()
    }
}

/// Parse an identity file: one `AGE-SECRET-KEY-1…` or SSH private key per
/// line, with comments ignored.
///
/// Takes the file's bytes rather than a path, so the caller decides where a
/// secret comes from — a file, or stdin. Spec §11.3.
pub fn parse_identities(text: &str) -> Result<Identities, Error> {
    let file = age::IdentityFile::from_buffer(text.as_bytes())
        .map_err(|err| Error::Identity(err.to_string()))?;
    let parsed = file
        .into_identities()
        .map_err(|err| Error::Identity(err.to_string()))?;

    if parsed.is_empty() {
        return Err(Error::NoIdentities);
    }
    Ok(Identities { parsed })
}

/// Encrypt to every recipient. Spec §6.1, §6.2.
///
/// `armor` produces age's ASCII armor, for a vault whose manifest asks for
/// it. Binary is recommended (§4.1): ciphertext is unreadable either way,
/// and armor costs a third more space.
pub fn encrypt(plaintext: &[u8], recipients: &Recipients, armor: bool) -> Result<Vec<u8>, Error> {
    if recipients.is_empty() {
        // §6.2: refuse rather than store plaintext. This is the last line
        // of defence for invariant 1.
        return Err(Error::NoRecipients);
    }

    let encryptor = age::Encryptor::with_recipients(
        recipients
            .parsed
            .iter()
            .map(|recipient| recipient.as_ref() as &dyn age::Recipient),
    )
    .map_err(|err| Error::Encrypt(err.to_string()))?;

    let mut output = Vec::new();
    if armor {
        let armored =
            age::armor::ArmoredWriter::wrap_output(&mut output, age::armor::Format::AsciiArmor)?;
        let mut writer = encryptor
            .wrap_output(armored)
            .map_err(|err| Error::Encrypt(err.to_string()))?;
        writer.write_all(plaintext)?;
        // Both finishes are required: the inner one completes the age
        // stream, the outer one closes the armor. Skipping either produces
        // a file that will not decrypt.
        writer
            .finish()
            .map_err(|err| Error::Encrypt(err.to_string()))?
            .finish()
            .map_err(|err| Error::Encrypt(err.to_string()))?;
    } else {
        let mut writer = encryptor
            .wrap_output(&mut output)
            .map_err(|err| Error::Encrypt(err.to_string()))?;
        writer.write_all(plaintext)?;
        writer
            .finish()
            .map_err(|err| Error::Encrypt(err.to_string()))?;
    }

    Ok(output)
}

/// Decrypt with any of `identities`. Spec §6.1.
///
/// Armored and binary payloads are both accepted without being told which:
/// age's armor reader detects its own header, so a vault whose `armor`
/// setting has changed since a file was written still reads.
///
/// The plaintext is returned in a [`Zeroizing`] buffer so it is wiped on
/// drop (§11.3).
pub fn decrypt(ciphertext: &[u8], identities: &Identities) -> Result<Zeroizing<Vec<u8>>, Error> {
    if identities.is_empty() {
        return Err(Error::NoIdentities);
    }

    let armored = age::armor::ArmoredReader::new(ciphertext);
    let decryptor = age::Decryptor::new(armored).map_err(|err| Error::Decrypt(err.to_string()))?;

    let mut reader = decryptor
        .decrypt(
            identities
                .parsed
                .iter()
                .map(|identity| identity.as_ref() as &dyn age::Identity),
        )
        .map_err(|err| Error::Decrypt(err.to_string()))?;

    let mut plaintext = Zeroizing::new(Vec::new());
    reader.read_to_end(&mut plaintext)?;
    Ok(plaintext)
}

/// Whether `bytes` begin a well-formed age payload. Spec §6.1.
///
/// Parses the header only, which needs no identity — so `fjord verify` can
/// report a corrupt payload without asking anyone for a key.
pub fn is_well_formed(bytes: &[u8]) -> bool {
    age::Decryptor::new(age::armor::ArmoredReader::new(bytes)).is_ok()
}

/// A freshly generated identity, and the recipient derived from it.
///
/// The secret is held in a [`Zeroizing`] string: it is written to a file
/// and wiped, never logged, and never placed in `argv` or an environment
/// variable.
#[derive(Debug)]
pub struct GeneratedIdentity {
    pub secret: Zeroizing<String>,
    /// The `age1…` public key. Not a secret: spec §4 notes that public keys
    /// are not secrets, which is why a vault manifest may carry them.
    pub recipient: String,
}

/// Generate an X25519 identity. Spec §6.2 requires X25519 recipients.
pub fn generate_identity() -> GeneratedIdentity {
    use age::secrecy::ExposeSecret;

    let identity = age::x25519::Identity::generate();
    let recipient = identity.to_public().to_string();
    let secret = Zeroizing::new(identity.to_string().expose_secret().to_string());

    GeneratedIdentity { secret, recipient }
}

/// The file an identity is conventionally written to, as `age-keygen`
/// writes it: a comment header, then the key on its own line.
pub fn identity_file_contents(identity: &GeneratedIdentity, created_at: &str) -> Zeroizing<String> {
    Zeroizing::new(format!(
        "# created: {created_at}\n\
         # public key: {}\n\
         # This file is a SECRET. Never commit it to the repository it\n\
         # decrypts (spec §11.3), and keep a copy somewhere you will still\n\
         # have it in five years: there is no recovery service.\n\
         {}\n",
        identity.recipient,
        identity.secret.as_str()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(armor: bool) {
        let identity = generate_identity();
        let recipients = match parse_recipients(&identity.recipient) {
            Ok(recipients) => recipients,
            Err(err) => panic!("{err}"),
        };
        assert_eq!(recipients.len(), 1);

        let plaintext = b"# Groceries\n\nmilk\noats\n";
        let ciphertext = match encrypt(plaintext, &recipients, armor) {
            Ok(ciphertext) => ciphertext,
            Err(err) => panic!("{err}"),
        };
        assert_ne!(&ciphertext[..], &plaintext[..]);
        assert!(is_well_formed(&ciphertext));

        let identities = match parse_identities(identity.secret.as_str()) {
            Ok(identities) => identities,
            Err(err) => panic!("{err}"),
        };
        let recovered = match decrypt(&ciphertext, &identities) {
            Ok(recovered) => recovered,
            Err(err) => panic!("{err}"),
        };
        assert_eq!(&recovered[..], plaintext);
    }

    #[test]
    fn a_binary_payload_round_trips() {
        round_trip(false);
    }

    #[test]
    fn an_armored_payload_round_trips() {
        round_trip(true);
    }

    #[test]
    fn armored_output_is_ascii_and_declares_itself() {
        let identity = generate_identity();
        let recipients = parse_recipients(&identity.recipient).expect("recipients");
        let ciphertext = encrypt(b"hello", &recipients, true).expect("encrypt");
        let text = String::from_utf8_lossy(&ciphertext);
        assert!(
            text.starts_with("-----BEGIN AGE ENCRYPTED FILE-----"),
            "{text}"
        );
        assert!(text
            .trim_end()
            .ends_with("-----END AGE ENCRYPTED FILE-----"));
    }

    #[test]
    fn every_recipient_can_decrypt() {
        // §6.2: encrypted to all recipients, so any one identity reads it.
        let first = generate_identity();
        let second = generate_identity();
        let file = format!("{}\n{}\n", first.recipient, second.recipient);
        let recipients = parse_recipients(&file).expect("recipients");
        assert_eq!(recipients.len(), 2);

        let ciphertext = encrypt(b"shared", &recipients, false).expect("encrypt");
        for identity in [&first, &second] {
            let identities = parse_identities(identity.secret.as_str()).expect("identity");
            let recovered = decrypt(&ciphertext, &identities).expect("decrypt");
            assert_eq!(&recovered[..], b"shared");
        }
    }

    #[test]
    fn a_stranger_cannot_decrypt() {
        let owner = generate_identity();
        let stranger = generate_identity();
        let recipients = parse_recipients(&owner.recipient).expect("recipients");
        let ciphertext = encrypt(b"secret", &recipients, false).expect("encrypt");

        let identities = parse_identities(stranger.secret.as_str()).expect("identity");
        assert!(matches!(
            decrypt(&ciphertext, &identities),
            Err(Error::Decrypt(_))
        ));
    }

    #[test]
    fn encrypting_to_nobody_is_refused() {
        // §6.2: refuse rather than store plaintext.
        let recipients = parse_recipients("# no keys here\n").expect("recipients");
        assert!(recipients.is_empty());
        assert!(matches!(
            encrypt(b"anything", &recipients, false),
            Err(Error::NoRecipients)
        ));
    }

    #[test]
    fn a_passphrase_recipient_is_refused_with_its_line() {
        let identity = generate_identity();
        let file = format!("{}\npassphrase\n", identity.recipient);
        match parse_recipients(&file) {
            Err(Error::Recipient { line, reason }) => {
                assert_eq!(line, 2);
                assert!(reason.contains("passphrase"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn an_ssh_recipient_is_refused_by_name_rather_than_silently() {
        // The vault is conforming (§6.2 permits SSH recipients) and this
        // build cannot write to it. Both halves have to be said, or the
        // user is left thinking their repository is broken.
        let identity = generate_identity();
        let file = format!(
            "{}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA user@host\n",
            identity.recipient
        );
        match parse_recipients(&file) {
            Err(Error::Recipient { line, reason }) => {
                assert_eq!(line, 2);
                assert!(reason.contains("not supported by this build"), "{reason}");
                assert!(reason.contains("RUSTSEC-2023-0071"), "{reason}");
                // And it says what to do instead.
                assert!(reason.contains("rekey"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn one_recipient_can_be_checked_on_its_own() {
        let key = generate_identity().recipient;
        assert!(check_recipient(&key).is_ok());
        assert!(check_recipient(&format!("  {key}  ")).is_ok());

        // Each way of being wrong says something different.
        let typo = format!("age1{}", "q".repeat(58));
        let reason = check_recipient(&typo).expect_err("a bad checksum");
        assert!(reason.contains("mistyped"), "{reason}");

        let reason = check_recipient("not a key").expect_err("rubbish");
        assert!(reason.contains("age1"), "{reason}");

        let reason = check_recipient("passphrase").expect_err("passphrase");
        assert!(reason.contains("§6.2"), "{reason}");

        let reason = check_recipient("ssh-ed25519 AAAAC3Nza user@host").expect_err("ssh");
        assert!(reason.contains("RUSTSEC-2023-0071"), "{reason}");

        assert!(check_recipient("").is_err());
        assert!(check_recipient("# a comment").is_err());
    }

    #[test]
    fn a_secret_key_is_refused_and_never_echoed() {
        // Someone will paste an identity where a public key was wanted. The
        // refusal has to tell them it is exposed, and `display_safe` is what
        // keeps a caller from printing it back.
        let secret = generate_identity().secret.as_str().to_string();
        let reason = check_recipient(&secret).expect_err("a secret key");
        assert!(reason.contains("secret key"), "{reason}");
        assert!(reason.contains("exposed"), "{reason}");
        assert!(!reason.contains(&secret), "the reason repeated the key");

        assert_eq!(display_safe(&secret), "(a secret key, not shown)");
        assert!(!display_safe(&secret).contains("AGE-SECRET-KEY"));
        // Case does not hide it.
        assert_eq!(
            display_safe(&secret.to_ascii_lowercase()),
            "(a secret key, not shown)"
        );
        // And an ordinary value is shown as it is.
        assert_eq!(display_safe("  age1abc  "), "age1abc");
    }

    #[test]
    fn a_malformed_recipient_is_refused_with_its_line() {
        match parse_recipients("# comment\nage1nonsense\n") {
            Err(Error::Recipient { line, .. }) => assert_eq!(line, 2),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn garbage_is_not_a_payload() {
        assert!(!is_well_formed(b"this is not an age file\n"));
        assert!(!is_well_formed(b""));
        // A truncated header is not well-formed either.
        assert!(!is_well_formed(b"age-encryption.org/v1\n"));
    }

    #[test]
    fn a_generated_identity_is_shaped_as_age_expects() {
        let identity = generate_identity();
        assert!(identity.secret.starts_with("AGE-SECRET-KEY-1"));
        assert!(identity.recipient.starts_with("age1"));
        // The same shape `fjord verify` accepts in a recipients file.
        assert_eq!(
            manifest::classify_recipient(&identity.recipient),
            Some(RecipientKind::X25519),
            "a key this crate generated must satisfy its own verifier"
        );
    }

    #[test]
    fn an_identity_file_round_trips_through_its_own_comments() {
        let identity = generate_identity();
        let contents = identity_file_contents(&identity, "2026-10-16T09:34:00Z");
        assert!(contents.contains("# public key:"));
        assert!(contents.contains("SECRET"));

        // age ignores the comments and finds the key.
        let identities = parse_identities(&contents).expect("parse");
        assert_eq!(identities.len(), 1);

        let recipients = parse_recipients(&identity.recipient).expect("recipients");
        let ciphertext = encrypt(b"x", &recipients, false).expect("encrypt");
        assert_eq!(
            &decrypt(&ciphertext, &identities).expect("decrypt")[..],
            b"x"
        );
    }

    #[test]
    fn an_identity_file_with_no_key_is_refused() {
        match parse_identities("# just a comment\n") {
            Err(Error::NoIdentities) | Err(Error::Identity(_)) => {}
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}

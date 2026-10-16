//! How a document becomes bytes in a vault, and back. Spec §6, §7.
//!
//! Three settings decide this, and every command needs all three to agree:
//! whether the vault is encrypted (§4), whether the payload is wrapped in a
//! tar container (§6.4), and whether the name on disk is the document's or
//! its ULID (§7.2). Deriving that in each command separately is how one of
//! them ends up writing a file another cannot read, so it is derived here
//! once.
//!
//! The order matters and is fixed by §6.4: **container first, then
//! encryption.** The archive is the plaintext; the age payload wraps it.
//! That is what makes `age -d | tar -x` the whole recovery procedure.

use crate::container;
use crate::crypto::{self, Identities, Recipients};
use crate::manifest;
use crate::vault::Vault;
use zeroize::Zeroizing;

/// Why a document could not be stored or loaded.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Crypto(#[from] crypto::Error),
    #[error(transparent)]
    Container(#[from] container::Error),
    /// §7.2: `fileNaming: "id"` requires a ULID to name the file by.
    #[error("this vault names files by id, so a document needs one")]
    IdRequired,
    /// An encrypted vault whose payload cannot be opened.
    #[error("no identity opens this document")]
    NeedsIdentity,
}

/// Whether this vault wraps payloads in a tar container. Spec §6.4.
pub fn uses_container(vault: &Vault) -> bool {
    container_mode(vault) == "tar"
}

/// Whether the name on disk is the document's ULID. Spec §7.2.
pub fn names_by_id(vault: &Vault) -> bool {
    vault.file_naming() == "id"
}

fn container_mode(vault: &Vault) -> &str {
    match vault.manifest.encryption() {
        manifest::EncryptionField::Object(encryption) => {
            manifest::object_string(encryption, manifest::field::CONTAINER).unwrap_or("none")
        }
        _ => "none",
    }
}

/// The leaf name a document takes on disk. Spec §6.3, §7.
///
/// In `plain` mode the suffix is appended to the document's own name, so the
/// original name and type survive decryption. In `id` mode the leaf is the
/// ULID, which is why the real name has to live inside the container.
pub fn on_disk_name(vault: &Vault, document_name: &str, id: Option<&str>) -> Result<String, Error> {
    let suffix = if vault.is_encrypted() {
        vault.suffix()
    } else {
        String::new()
    };

    if names_by_id(vault) {
        let id = id.ok_or(Error::IdRequired)?;
        return Ok(format!("{id}{suffix}"));
    }
    Ok(format!("{document_name}{suffix}"))
}

/// Turn a document into the bytes that go on disk. Spec §6.4.
///
/// `document_name` is the document's real leaf name, which the container
/// carries when there is one.
pub fn store(
    vault: &Vault,
    document_name: &str,
    plaintext: &[u8],
    recipients: Option<&Recipients>,
) -> Result<Vec<u8>, Error> {
    let body = if uses_container(vault) {
        Zeroizing::new(container::wrap(document_name, plaintext)?)
    } else {
        Zeroizing::new(plaintext.to_vec())
    };

    if !vault.is_encrypted() {
        return Ok(body.to_vec());
    }
    let recipients = recipients.ok_or(Error::Crypto(crypto::Error::NoRecipients))?;
    Ok(crypto::encrypt(&body, recipients, vault.armor())?)
}

/// A document, read back out of a vault.
#[derive(Debug)]
pub struct Loaded {
    /// The document's real name, when the container carried one. `None`
    /// means the name is the one on disk.
    pub name: Option<String>,
    pub plaintext: Zeroizing<Vec<u8>>,
}

/// Read stored bytes back into a document. Spec §6.1, §6.4.
pub fn load(
    vault: &Vault,
    stored: &[u8],
    identities: Option<&Identities>,
) -> Result<Loaded, Error> {
    let body = if vault.is_encrypted() {
        let identities = identities.ok_or(Error::NeedsIdentity)?;
        crypto::decrypt(stored, identities)?
    } else {
        Zeroizing::new(stored.to_vec())
    };

    if !uses_container(vault) {
        return Ok(Loaded {
            name: None,
            plaintext: body,
        });
    }

    // §11.5: the entry name is untrusted input, and `container::unwrap`
    // refuses a path or a `..` rather than handing one back.
    let unwrapped = container::unwrap(&body)?;
    Ok(Loaded {
        name: Some(unwrapped.name),
        plaintext: Zeroizing::new(unwrapped.contents),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use std::path::PathBuf;

    fn vault(encryption: &str, file_naming: &str) -> Vault {
        let json = format!(
            r#"{{"fjord":1,"id":"01JAGC4K7PR9TBM3YKWX6ZQ2HV","name":"V","createdAt":"2026-10-16T09:34:00Z","encryption":{encryption},"fileNaming":"{file_naming}"}}"#
        );
        Vault {
            directory: "V".to_string(),
            path: PathBuf::from("/repo/V"),
            manifest: Manifest::parse(json.as_bytes()).expect("parse"),
        }
    }

    fn encrypted(container: &str) -> String {
        format!(
            r#"{{"tool":"age","recipients":"recipients.txt","suffix":".age","container":"{container}","armor":false}}"#
        )
    }

    fn keys() -> (Recipients, Identities) {
        let identity = crypto::generate_identity();
        (
            crypto::parse_recipients(&identity.recipient).expect("recipients"),
            crypto::parse_identities(identity.secret.as_str()).expect("identities"),
        )
    }

    #[test]
    fn a_plain_encrypted_vault_stores_the_payload_alone() {
        let vault = vault(&encrypted("none"), "plain");
        let (recipients, identities) = keys();
        assert!(!uses_container(&vault));
        assert!(!names_by_id(&vault));

        let stored = store(&vault, "notes.md", b"# Notes\n", Some(&recipients)).expect("store");
        let loaded = load(&vault, &stored, Some(&identities)).expect("load");
        // No container, so no name to carry: the name is on disk.
        assert_eq!(loaded.name, None);
        assert_eq!(&loaded.plaintext[..], b"# Notes\n");
        assert_eq!(
            on_disk_name(&vault, "notes.md", None).expect("name"),
            "notes.md.age"
        );
    }

    #[test]
    fn an_id_vault_carries_the_name_inside_the_container() {
        // §7.2: the name is not on disk, so it has to be in the payload.
        let vault = vault(&encrypted("tar"), "id");
        let (recipients, identities) = keys();
        assert!(uses_container(&vault));
        assert!(names_by_id(&vault));

        let id = "01JAGC4K7PT8Y3WQNMZV5XRB7H";
        let stored = store(&vault, "my sync design.md", b"body", Some(&recipients)).expect("store");
        assert_eq!(
            on_disk_name(&vault, "my sync design.md", Some(id)).expect("name"),
            format!("{id}.age")
        );

        let loaded = load(&vault, &stored, Some(&identities)).expect("load");
        assert_eq!(loaded.name.as_deref(), Some("my sync design.md"));
        assert_eq!(&loaded.plaintext[..], b"body");
    }

    #[test]
    fn an_id_vault_needs_an_id_to_name_a_file_by() {
        let vault = vault(&encrypted("tar"), "id");
        assert!(matches!(
            on_disk_name(&vault, "notes.md", None),
            Err(Error::IdRequired)
        ));
    }

    #[test]
    fn a_plaintext_vault_stores_the_bytes_as_they_are() {
        let vault = vault("null", "plain");
        let stored = store(&vault, "notes.md", b"# Notes\n", None).expect("store");
        assert_eq!(stored, b"# Notes\n");
        let loaded = load(&vault, &stored, None).expect("load");
        assert_eq!(&loaded.plaintext[..], b"# Notes\n");
        assert_eq!(
            on_disk_name(&vault, "notes.md", None).expect("name"),
            "notes.md"
        );
    }

    #[test]
    fn the_container_comes_before_the_encryption() {
        // §6.4: the archive is the plaintext and age wraps it, which is
        // what makes `age -d | tar -x` the whole recovery procedure. The
        // other order would need `tar -x | age -d`, which cannot work.
        let vault = vault(&encrypted("tar"), "id");
        let (recipients, identities) = keys();
        let stored = store(&vault, "notes.md", b"body", Some(&recipients)).expect("store");

        // What age yields is a tar archive, not the document.
        let inner = crypto::decrypt(&stored, &identities).expect("decrypt");
        let unwrapped = container::unwrap(&inner).expect("a tar archive");
        assert_eq!(unwrapped.name, "notes.md");
        assert_eq!(unwrapped.contents, b"body");
    }

    #[test]
    fn an_encrypted_document_needs_an_identity() {
        let vault = vault(&encrypted("tar"), "id");
        let (recipients, _) = keys();
        let stored = store(&vault, "notes.md", b"body", Some(&recipients)).expect("store");
        assert!(matches!(
            load(&vault, &stored, None),
            Err(Error::NeedsIdentity)
        ));
    }

    #[test]
    fn a_malformed_container_is_reported_as_such() {
        // E303's path: the archive is inside the ciphertext, so this can
        // only surface when a document is read.
        let vault = vault(&encrypted("tar"), "id");
        let (recipients, identities) = keys();
        let rubbish = crypto::encrypt(b"not a tar archive", &recipients, false).expect("encrypt");
        assert!(matches!(
            load(&vault, &rubbish, Some(&identities)),
            Err(Error::Container(_))
        ));
    }
}

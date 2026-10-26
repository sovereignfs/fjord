import { Alert, Badge, Icon } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { ClassifiedFile, VaultListing } from "../../format/types";
import { repositoryHref } from "../links";
import type { RepositoryRead } from "../repository";
import { ChooseVaultButton } from "./ChooseVaultButton";

/**
 * The vaults of a repository and what is in each, from names alone (DESIGN.md §8): documents and notes can be
 * opened, any other file is greyed, and an encrypted vault is locked. Nothing is downloaded to draw it.
 */
export function VaultList({ read, connectionId, opensOn }: { read: RepositoryRead; connectionId: number; /** The directory of the vault the repository opens on. */ opensOn?: string | undefined }) {
  const { discovery, partial, manifest } = read;
  return (
    <>
      {manifest === null ? (
        <div className={styles.notice}>
          <Alert variant="info">This repository has no <code>fjord.json</code>. Its vaults are found from the files themselves.</Alert>
        </div>
      ) : manifest.ok ? null : (
        <div className={styles.notice}>
          <Alert variant="warning">This repository's <code>fjord.json</code> cannot be read, so it may not be a Fjord repository: {manifest.error}</Alert>
        </div>
      )}
      {discovery.nested.length > 0 ? (
        <div className={styles.notice}>
          <Alert variant="warning">Vaults inside other folders are not supported in this version of the format, so these are not shown: {discovery.nested.join(", ")}.</Alert>
        </div>
      ) : null}
      {discovery.vaults.length === 0 ? (
        <p>This repository has no vaults yet: no folder in it holds a <code>fjord.vault.json</code>.</p>
      ) : (
        <ul className={styles.list} aria-label="Vaults">
          {discovery.vaults.map((vault) => (
            <li key={vault.directory} className={styles.item}>
              <span>
                <a href={repositoryHref(connectionId, vault.directory)}>
                  <strong>{vault.name ?? vault.directory}</strong>
                </a>
                {vault.name !== null && vault.name !== vault.directory ? <span className={styles.itemMeta}> · {vault.directory}</span> : null}
                {vault.directory === opensOn ? (
                  <>
                    {" "}
                    <Badge>Opens first</Badge>
                  </>
                ) : null}
                {vault.encrypted ? (
                  <>
                    {" "}
                    <Badge>
                      <Icon name="lock" aria-label="Encrypted" /> Encrypted
                    </Badge>
                  </>
                ) : null}
                <span className={styles.itemMeta}> · {summary(vault, partial)}</span>
              </span>
              {discovery.vaults.length > 1 && vault.directory !== opensOn ? (
                <ChooseVaultButton connectionId={connectionId} vault={vault.directory} label={vault.name ?? vault.directory} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function count(files: ClassifiedFile[], ...kinds: ClassifiedFile["kind"][]) {
  return files.filter((file) => kinds.includes(file.kind)).length;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summary(vault: VaultListing, partial: boolean): string {
  if (vault.manifestError !== null) return "its manifest cannot be read";
  if (partial) return "too large to list at once";
  if (vault.encrypted) {
    const locked = count(vault.files, "payload");
    const stray = count(vault.files, "stray");
    return [plural(locked, "encrypted file", "encrypted files"), stray > 0 ? `${plural(stray, "plaintext file", "plaintext files")} that should not be there` : ""].filter(Boolean).join(", ");
  }
  const documents = count(vault.files, "document");
  const notes = count(vault.files, "note");
  const others = count(vault.files, "other", "misplacedPayload");
  if (documents + notes + others === 0) return "empty";
  return [plural(documents, "document", "documents"), plural(notes, "note", "notes"), plural(others, "other file", "other files")].join(", ");
}
